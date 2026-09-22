import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { type Construct } from 'constructs';

/**
 * Per-route throttles for the endpoints that spend money on every call, either a
 * Serper web search, a Bedrock invocation, or both. These are total limits across
 * all callers rather than per-IP, so they bound the bill but do not stop one
 * client from consuming the budget. Per-IP limiting needs WAF, which is the next
 * step if abuse actually shows up.
 *
 * The numbers are set so a person clicking around never notices and a script
 * hits a wall immediately.
 */
const EXPENSIVE_ROUTES: Record<string, apigateway.MethodDeploymentOptions> = {
  // Runs a web search plus a model call, and fans out to several candidates when
  // an address matches more than one parcel. The costliest route in the API.
  '/parcels/lookup/GET': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
  // Each miss is a web search plus a model call.
  '/parcels/{id}/listing-status/GET': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
  // Each miss is a Bedrock summary.
  '/parcels/{id}/insights/GET': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
  // Queues a worker that resolves for-sale status for a whole result set, so one
  // request can become many model calls.
  '/search/POST': { throttlingRateLimit: 1, throttlingBurstLimit: 3 },
  // Cheap in itself, but each call can wake a paused Aurora cluster.
  '/warmup/GET': { throttlingRateLimit: 1, throttlingBurstLimit: 2 },
};

interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  database: rds.DatabaseClusterFromSnapshot;
  searchesTable: dynamodb.Table;
  parcelCacheTable: dynamodb.Table;
  allowedOrigins: string[];
  geocoderContactEmail: string;
}

const API_DIR = path.join(__dirname, '../../services/api');
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const SEARCH_WORKER_TIMEOUT = cdk.Duration.seconds(120);

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { userPool, userPoolClient, database, searchesTable, parcelCacheTable, allowedOrigins, geocoderContactEmail } = props;

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'landfinder-alarms',
      displayName: 'LandFinder Infrastructure Alarms',
    });

    const searchJobsDlq = new sqs.Queue(this, 'SearchJobsDlq', {
      queueName: 'landfinder-search-jobs-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });
    const searchJobsQueue = new sqs.Queue(this, 'SearchJobsQueue', {
      queueName: 'landfinder-search-jobs',
      // Must exceed the worker timeout so a running job is not redelivered.
      visibilityTimeout: cdk.Duration.seconds(SEARCH_WORKER_TIMEOUT.toSeconds() + 30),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: { queue: searchJobsDlq, maxReceiveCount: 3 },
    });

    // Created empty. Set { "apiKey": "..." } in Secrets Manager after deploy.
    const serperSecret = new secretsmanager.Secret(this, 'SerperSecret', {
      secretName: 'landfinder/serper',
      description: 'Serper.dev API key for the listing status web search',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiKey: '' }),
        generateStringKey: 'placeholder',
      },
    });

    const commonEnv = {
      DATABASE_CLUSTER_ARN: database.clusterArn,
      DATABASE_SECRET_ARN: database.secret!.secretArn,
      DATABASE_NAME: 'landfinder',
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      SEARCHES_TABLE: searchesTable.tableName,
      PARCEL_CACHE_TABLE: parcelCacheTable.tableName,
      SERPER_SECRET_ARN: serperSecret.secretArn,
      BEDROCK_MODEL_ID,
      GEOCODER_CONTACT_EMAIL: geocoderContactEmail,
      NODE_OPTIONS: '--enable-source-maps',
      POWERTOOLS_SERVICE_NAME: 'landfinder-api',
      POWERTOOLS_METRICS_NAMESPACE: 'LandFinder',
      LOG_LEVEL: 'INFO',
    };

    const createFunction = (name: string, entry: string, overrides: Partial<lambdaNode.NodejsFunctionProps> = {}) =>
      new lambdaNode.NodejsFunction(this, `${name}Function`, {
        functionName: `landfinder-${entry.replace('/', '-').replace('.ts', '').replace('-handler', '')}`,
        entry: path.join(API_DIR, entry),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(30),
        tracing: lambda.Tracing.ACTIVE,
        environment: { ...commonEnv, ...overrides.environment },
        bundling: {
          minify: true,
          sourceMap: true,
          externalModules: ['@aws-sdk/*'],
          loader: { '.sql': 'text' },
        },
        ...overrides,
      });

    const authLoginFn = createFunction('AuthLogin', 'auth/login.ts');
    const authRegisterFn = createFunction('AuthRegister', 'auth/register.ts');
    const authRefreshFn = createFunction('AuthRefresh', 'auth/refresh.ts');
    const searchFn = createFunction('Search', 'search/handler.ts');
    // Resolves for-sale status for up to 15 uncached parcels per job, five at a
    // time, which is why it gets a long timeout.
    const searchWorkerFn = createFunction('SearchWorker', 'search/worker.ts', {
      memorySize: 512,
      timeout: SEARCH_WORKER_TIMEOUT,
    });
    const parcelFn = createFunction('Parcel', 'parcel/handler.ts', { timeout: cdk.Duration.seconds(60) });
    // An ambiguous lookup checks for-sale status on up to 10 candidates.
    const parcelLookupFn = createFunction('ParcelLookup', 'parcel/lookup.ts');
    const migrationFn = createFunction('Migration', 'migration/handler.ts', { timeout: cdk.Duration.seconds(120) });
    const userFn = createFunction('User', 'user/handler.ts');
    // Wakes Aurora ahead of the first real query. Runs every 12 hours so a
    // paused cluster never falls into the slower deep-sleep resume.
    const dbWarmupFn = createFunction('DbWarmup', 'warmup/handler.ts', { timeout: cdk.Duration.seconds(60) });

    searchWorkerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(searchJobsQueue, { batchSize: 1, reportBatchItemFailures: true })
    );
    new events.Rule(this, 'DbWarmupSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(12)),
      targets: [new eventsTargets.LambdaFunction(dbWarmupFn)],
    });

    for (const fn of [searchWorkerFn, parcelFn, parcelLookupFn, userFn, migrationFn, dbWarmupFn]) {
      database.grantDataApiAccess(fn);
    }

    const bedrockInvokePolicy = new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-*`,
      ],
    });
    for (const fn of [parcelFn, parcelLookupFn, searchWorkerFn]) {
      serperSecret.grantRead(fn);
      fn.addToRolePolicy(bedrockInvokePolicy);
    }

    searchesTable.grantReadWriteData(searchFn);
    searchesTable.grantReadWriteData(searchWorkerFn);
    searchesTable.grantReadData(userFn);
    // The parcel handler reads and writes the cache; lookup invalidates it after an upsert.
    parcelCacheTable.grantReadWriteData(parcelFn);
    parcelCacheTable.grantReadWriteData(parcelLookupFn);
    searchJobsQueue.grantSendMessages(searchFn);

    const cognitoPolicy = new iam.PolicyStatement({
      actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminInitiateAuth', 'cognito-idp:AdminSetUserPassword'],
      resources: [userPool.userPoolArn],
    });
    for (const fn of [authLoginFn, authRegisterFn, authRefreshFn]) {
      fn.addToRolePolicy(cognitoPolicy);
    }

    this.api = new apigateway.RestApi(this, 'LandFinderApi', {
      restApiName: 'LandFinder API',
      deployOptions: {
        stageName: 'v1',
        // Read routes are public, so these limits are the spend ceiling rather
        // than a fairness control. The default covers cached reads, which are
        // cheap. Routes that call Serper or Bedrock are capped far lower below,
        // because each request there costs real money and an unauthenticated
        // loop against them would be a billing incident.
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        methodOptions: EXPENSIVE_ROUTES,
        tracingEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
      },
    });

    // Public. Anyone can search and read parcels; only saving requires an account.
    const authOptions: apigateway.MethodOptions = {
      authorizer: new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
        cognitoUserPools: [userPool],
        authorizerName: 'LandFinderAuthorizer',
      }),
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };
    const integrate = (fn: lambda.IFunction) => new apigateway.LambdaIntegration(fn);

    const auth = this.api.root.addResource('auth');
    auth.addResource('login').addMethod('POST', integrate(authLoginFn));
    auth.addResource('register').addMethod('POST', integrate(authRegisterFn));
    auth.addResource('refresh').addMethod('POST', integrate(authRefreshFn));

    // Search is anonymous. A signed-in caller's job is attributed to them and
    // stays private; an anonymous job is readable only with its random id.
    const search = this.api.root.addResource('search');
    search.addMethod('POST', integrate(searchFn));
    const searchJob = search.addResource('{jobId}');
    searchJob.addMethod('GET', integrate(searchFn));
    searchJob.addResource('results').addMethod('GET', integrate(searchFn));

    const parcels = this.api.root.addResource('parcels');
    parcels.addResource('lookup').addMethod('GET', integrate(parcelLookupFn));
    const parcel = parcels.addResource('{id}');
    parcel.addMethod('GET', integrate(parcelFn));
    for (const sub of [
      'water-rights', 'insights', 'hunting-districts', 'stream-gauges', 'road-access', 'utilities',
      'environmental-risk', 'conservation-easements', 'listing-status', 'soil', 'groundwater',
    ]) {
      parcel.addResource(sub).addMethod('GET', integrate(parcelFn));
    }

    // Public because the client calls it before a search, and throttled hard
    // because holding a paused cluster awake is itself a cost.
    this.api.root.addResource('warmup').addMethod('GET', integrate(dbWarmupFn));

    const user = this.api.root.addResource('user');
    const saved = user.addResource('saved');
    saved.addMethod('GET', integrate(userFn), authOptions);
    const savedParcel = saved.addResource('{parcelId}');
    savedParcel.addMethod('POST', integrate(userFn), authOptions);
    savedParcel.addMethod('DELETE', integrate(userFn), authOptions);
    user.addResource('searches').addMethod('GET', integrate(userFn), authOptions);

    // Without CORS headers on gateway-generated errors, the browser reports a
    // CORS failure instead of the real 401 or 403.
    const gatewayResponses: Array<[string, apigateway.ResponseType]> = [
      ['UnauthorizedGatewayResponse', apigateway.ResponseType.UNAUTHORIZED],
      ['AccessDeniedGatewayResponse', apigateway.ResponseType.ACCESS_DENIED],
      ['Default4xxGatewayResponse', apigateway.ResponseType.DEFAULT_4XX],
      ['Default5xxGatewayResponse', apigateway.ResponseType.DEFAULT_5XX],
    ];
    for (const [responseId, type] of gatewayResponses) {
      this.api.addGatewayResponse(responseId, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': "'*'",
          'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        },
      });
    }

    const alarmAction = new cloudwatchActions.SnsAction(alarmTopic);
    const alarm = (alarmId: string, alarmProps: cloudwatch.AlarmProps) =>
      new cloudwatch.Alarm(this, alarmId, { treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, ...alarmProps })
        .addAlarmAction(alarmAction);
    const customMetric = (metricName: string, period: cdk.Duration) =>
      new cloudwatch.Metric({
        namespace: 'LandFinder',
        metricName,
        dimensionsMap: { service: 'landfinder-api' },
        period,
        statistic: 'p99',
      });

    alarm('Api5xxAlarm', {
      alarmName: 'landfinder-api-5xx-errors',
      metric: this.api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 2,
    });
    alarm('SearchFunctionErrorAlarm', {
      alarmName: 'landfinder-search-function-errors',
      metric: searchFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 2,
    });
    alarm('SearchDlqAlarm', {
      alarmName: 'landfinder-search-jobs-dlq',
      alarmDescription: 'A search job failed all retries',
      metric: searchJobsDlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    alarm('ParcelFunctionErrorAlarm', {
      alarmName: 'landfinder-parcel-function-errors',
      metric: parcelFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 2,
    });
    alarm('SearchLatencyAlarm', {
      alarmName: 'landfinder-search-latency-p99',
      metric: customMetric('SearchLatency', cdk.Duration.minutes(5)),
      threshold: 5000,
      evaluationPeriods: 3,
    });
    alarm('BedrockLatencyAlarm', {
      alarmName: 'landfinder-bedrock-latency',
      metric: customMetric('BedrockCallLatency', cdk.Duration.minutes(10)),
      threshold: 10000,
      evaluationPeriods: 3,
    });

    new cdk.CfnOutput(this, 'ApiEndpointOutput', { value: this.api.url, exportName: 'LandFinderApiEndpoint' });
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      exportName: 'LandFinderAlarmTopicArn',
      description: 'Subscribe an email or pager endpoint to receive alarms',
    });
  }
}
