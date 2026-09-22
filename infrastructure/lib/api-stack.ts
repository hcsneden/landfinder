import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  database: rds.DatabaseClusterFromSnapshot;
  vpc: ec2.Vpc;
  usersTable: dynamodb.Table;
  searchesTable: dynamodb.Table;
  allowedOrigins: string[];
}

export class ApiStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { userPool, userPoolClient, database, vpc, usersTable, searchesTable, allowedOrigins } = props;

    // Unused since the Lambdas moved out of the VPC. Kept for one deploy so CloudFormation
    // does not try to delete it while Lambda's VPC network interfaces are still draining.
    new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Security group for LandFinder Lambda functions',
      allowAllOutbound: true,
    });

    // SNS topic for alarm notifications — subscribe an email or PagerDuty endpoint after deploy
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'landfinder-alarms',
      displayName: 'LandFinder Infrastructure Alarms',
    });

    // SQS queue for async search jobs
    const searchJobsDlq = new sqs.Queue(this, 'SearchJobsDlq', {
      queueName: 'landfinder-search-jobs-dlq',
      retentionPeriod: cdk.Duration.days(14),
    });

    const searchJobsQueue = new sqs.Queue(this, 'SearchJobsQueue', {
      queueName: 'landfinder-search-jobs',
      // Visibility timeout must exceed the worker Lambda timeout (60s) to prevent duplicate processing
      visibilityTimeout: cdk.Duration.seconds(90),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        queue: searchJobsDlq,
        maxReceiveCount: 3,
      },
    });

    // Serper.dev API key for the "is this for sale?" check — provides Google SERP
    // results that are fed to the existing Bedrock client for classification, no
    // separate model/account integration needed. (Replaces Google's Custom Search
    // JSON API, which Google closed to new customers.) Created as a placeholder —
    // after deploy, populate it via Secrets Manager with the real { apiKey } JSON
    // from serper.dev.
    const serperSecret = new secretsmanager.Secret(this, 'SerperSecret', {
      secretName: 'landfinder/serper',
      description: 'Serper.dev API key (apiKey) for listing-status web search',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiKey: '' }),
        generateStringKey: 'placeholder',
      },
    });

    // Common Lambda environment variables
    const commonEnv = {
      DATABASE_CLUSTER_ARN: database.clusterArn,
      DATABASE_SECRET_ARN: database.secret!.secretArn,
      DATABASE_NAME: 'landfinder',
      USERS_TABLE: usersTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      NODE_OPTIONS: '--enable-source-maps',
      // AWS Lambda Powertools
      POWERTOOLS_SERVICE_NAME: 'landfinder-api',
      POWERTOOLS_METRICS_NAMESPACE: 'LandFinder',
      LOG_LEVEL: 'INFO',
      POWERTOOLS_LOGGER_LOG_EVENT: 'false',
    };

    // Common Lambda configuration
    const lambdaDefaults: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ['@aws-sdk/*'],
      },
    };

    // Lambda functions
    const authLoginFn = new lambdaNode.NodejsFunction(this, 'AuthLoginFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-auth-login',
      entry: path.join(__dirname, '../../services/api/auth/login.ts'),
      handler: 'handler',
    });

    const authRegisterFn = new lambdaNode.NodejsFunction(this, 'AuthRegisterFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-auth-register',
      entry: path.join(__dirname, '../../services/api/auth/register.ts'),
      handler: 'handler',
    });

    // Search API handler: validates and enqueues jobs; returns immediately
    const searchFn = new lambdaNode.NodejsFunction(this, 'SearchFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-search',
      entry: path.join(__dirname, '../../services/api/search/handler.ts'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        SEARCHES_TABLE: searchesTable.tableName,
        SEARCH_QUEUE_URL: searchJobsQueue.queueUrl,
      },
    });

    // Search worker: SQS-triggered; runs the actual PostGIS query and writes results
    const searchWorkerFn = new lambdaNode.NodejsFunction(this, 'SearchWorkerFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-search-worker',
      entry: path.join(__dirname, '../../services/api/search/worker.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: {
        ...commonEnv,
        SEARCHES_TABLE: searchesTable.tableName,
      },
    });

    searchWorkerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(searchJobsQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      })
    );

    const parcelFn = new lambdaNode.NodejsFunction(this, 'ParcelFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-parcel',
      entry: path.join(__dirname, '../../services/api/parcel/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      environment: {
        ...commonEnv,
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        SERPER_SECRET_ARN: serperSecret.secretArn,
      },
    });

    // Lookup by address or parcel number — queries Cadastral ArcGIS + seeds water rights inline.
    // Timeout is higher than other lookups because an ambiguous (multi-candidate) search
    // also runs up to 10 parallel web search + Bedrock "is this for sale?" checks.
    const parcelLookupFn = new lambdaNode.NodejsFunction(this, 'ParcelLookupFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-parcel-lookup',
      entry: path.join(__dirname, '../../services/api/parcel/lookup.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...commonEnv,
        SERPER_SECRET_ARN: serperSecret.secretArn,
        BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        // Montana state GIS servers use intermediate CAs not in the Lambda cert bundle
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
    });

    const migrationFn = new lambdaNode.NodejsFunction(this, 'MigrationFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-migration',
      entry: path.join(__dirname, '../../services/api/migration/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
    });
    database.grantDataApiAccess(migrationFn);

    // Aurora pauses after 10 idle minutes and resumes in ~20s, longer after a day paused,
    // which would exceed API Gateway's timeout. A ping every 12 hours keeps it out of deep
    // sleep, and the web app calls GET /warmup on load so the resume overlaps with the user
    // reading the map instead of landing inside their first search.
    const dbWarmupFn = new lambdaNode.NodejsFunction(this, 'DbWarmupFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-db-warmup',
      entry: path.join(__dirname, '../../services/api/warmup/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
    });
    database.grantDataApiAccess(dbWarmupFn);
    new events.Rule(this, 'DbWarmupSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.hours(12)),
      targets: [new eventsTargets.LambdaFunction(dbWarmupFn)],
    });

    const userFn = new lambdaNode.NodejsFunction(this, 'UserFunction', {
      ...lambdaDefaults,
      functionName: 'landfinder-user',
      entry: path.join(__dirname, '../../services/api/user/handler.ts'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        SEARCHES_TABLE: searchesTable.tableName,
      },
    });

    // IAM permissions
    database.grantDataApiAccess(authLoginFn);
    database.grantDataApiAccess(authRegisterFn);
    database.grantDataApiAccess(searchWorkerFn);
    database.grantDataApiAccess(parcelFn);
    database.grantDataApiAccess(parcelLookupFn);
    database.grantDataApiAccess(userFn);

    serperSecret.grantRead(parcelFn);
    serperSecret.grantRead(parcelLookupFn);

    searchesTable.grantReadWriteData(searchFn);
    searchesTable.grantReadWriteData(searchWorkerFn);
    searchesTable.grantReadData(userFn);
    searchJobsQueue.grantSendMessages(searchFn);

    const bedrockInvokePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
        'arn:aws:bedrock:*::foundation-model/us.anthropic.claude-*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-*`,
      ],
    });
    parcelFn.addToRolePolicy(bedrockInvokePolicy);
    // Also needed for the listing-status check on ambiguous (multi-candidate) lookups
    parcelLookupFn.addToRolePolicy(bedrockInvokePolicy);

    usersTable.grantReadWriteData(authLoginFn);
    usersTable.grantReadWriteData(authRegisterFn);
    usersTable.grantReadWriteData(userFn);

    const cognitoPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminInitiateAuth',
        'cognito-idp:AdminRespondToAuthChallenge',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminGetUser',
      ],
      resources: [userPool.userPoolArn],
    });

    authLoginFn.addToRolePolicy(cognitoPolicy);
    authRegisterFn.addToRolePolicy(cognitoPolicy);

    // API Gateway
    this.api = new apigateway.RestApi(this, 'LandFinderApi', {
      restApiName: 'LandFinder API',
      description: 'API for LandFinder land search application',
      deployOptions: {
        stageName: 'v1',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        tracingEnabled: true,
        metricsEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key'],
      },
    });

    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      'CognitoAuthorizer',
      {
        cognitoUserPools: [userPool],
        authorizerName: 'LandFinderAuthorizer',
      }
    );

    const authResource = this.api.root.addResource('auth');
    authResource.addResource('login').addMethod('POST', new apigateway.LambdaIntegration(authLoginFn));
    authResource.addResource('register').addMethod('POST', new apigateway.LambdaIntegration(authRegisterFn));

    const authOptions = {
      authorizer: cognitoAuthorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const searchResource = this.api.root.addResource('search');
    searchResource.addMethod('POST', new apigateway.LambdaIntegration(searchFn), authOptions);

    const searchByIdResource = searchResource.addResource('{jobId}');
    searchByIdResource.addMethod('GET', new apigateway.LambdaIntegration(searchFn), authOptions);
    searchByIdResource.addResource('results').addMethod('GET', new apigateway.LambdaIntegration(searchFn), authOptions);

    const parcelsResource = this.api.root.addResource('parcels');
    parcelsResource.addResource('lookup').addMethod('GET', new apigateway.LambdaIntegration(parcelLookupFn), authOptions);
    const parcelByIdResource = parcelsResource.addResource('{id}');
    parcelByIdResource.addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('water-rights').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('listings').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('insights').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('hunting-districts').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('stream-gauges').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('road-access').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('utilities').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('environmental-risk').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('conservation-easements').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('listing-status').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('soil').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);
    parcelByIdResource.addResource('groundwater').addMethod('GET', new apigateway.LambdaIntegration(parcelFn), authOptions);

    // Wakes a paused Aurora cluster ahead of the first real query. Authorized so it
    // cannot be used anonymously to hold the cluster awake.
    this.api.root
      .addResource('warmup')
      .addMethod('GET', new apigateway.LambdaIntegration(dbWarmupFn), authOptions);

    const userResource = this.api.root.addResource('user');
    const savedResource = userResource.addResource('saved');
    savedResource.addMethod('GET', new apigateway.LambdaIntegration(userFn), authOptions);
    const savedByIdResource = savedResource.addResource('{parcelId}');
    savedByIdResource.addMethod('POST', new apigateway.LambdaIntegration(userFn), authOptions);
    savedByIdResource.addMethod('DELETE', new apigateway.LambdaIntegration(userFn), authOptions);
    userResource.addResource('searches').addMethod('GET', new apigateway.LambdaIntegration(userFn), authOptions);

    // CloudWatch alarms
    const alarmAction = new cloudwatch_actions.SnsAction(alarmTopic);

    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmName: 'landfinder-api-5xx-errors',
      alarmDescription: 'API Gateway returning elevated 5xx errors — check Lambda logs',
      metric: this.api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxAlarm.addAlarmAction(alarmAction);

    const searchErrorAlarm = new cloudwatch.Alarm(this, 'SearchFunctionErrorAlarm', {
      alarmName: 'landfinder-search-function-errors',
      alarmDescription: 'Search Lambda throwing unhandled errors',
      metric: searchFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    searchErrorAlarm.addAlarmAction(alarmAction);

    // Any message in the DLQ means a search job failed all 3 retries — page immediately
    const searchDlqAlarm = new cloudwatch.Alarm(this, 'SearchDlqAlarm', {
      alarmName: 'landfinder-search-jobs-dlq',
      alarmDescription: 'Search jobs landing in DLQ after 3 retries — worker is consistently failing',
      metric: searchJobsDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    searchDlqAlarm.addAlarmAction(alarmAction);

    const parcelErrorAlarm = new cloudwatch.Alarm(this, 'ParcelFunctionErrorAlarm', {
      alarmName: 'landfinder-parcel-function-errors',
      alarmDescription: 'Parcel Lambda throwing unhandled errors — may affect insight generation',
      metric: parcelFn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    parcelErrorAlarm.addAlarmAction(alarmAction);

    const searchLatencyAlarm = new cloudwatch.Alarm(this, 'SearchLatencyAlarm', {
      alarmName: 'landfinder-search-latency-p99',
      alarmDescription: 'Search worker p99 latency above 5 seconds — PostGIS query may need optimization',
      metric: new cloudwatch.Metric({
        namespace: 'LandFinder',
        metricName: 'SearchLatency',
        dimensionsMap: { service: 'landfinder-api' },
        period: cdk.Duration.minutes(5),
        statistic: 'p99',
      }),
      threshold: 5000,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    searchLatencyAlarm.addAlarmAction(alarmAction);

    const bedrockLatencyAlarm = new cloudwatch.Alarm(this, 'BedrockLatencyAlarm', {
      alarmName: 'landfinder-bedrock-latency',
      alarmDescription: 'Bedrock insight generation p99 above 10 seconds',
      metric: new cloudwatch.Metric({
        namespace: 'LandFinder',
        metricName: 'BedrockCallLatency',
        dimensionsMap: { service: 'landfinder-api' },
        period: cdk.Duration.minutes(10),
        statistic: 'p99',
      }),
      threshold: 10000,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    bedrockLatencyAlarm.addAlarmAction(alarmAction);

    // CORS headers on API Gateway error responses (e.g., Cognito authorizer 401s)
    // Without these, the browser sees a CORS error instead of the actual HTTP error code.
    for (const [id, type] of [
      ['UnauthorizedGatewayResponse', apigateway.ResponseType.UNAUTHORIZED],
      ['AccessDeniedGatewayResponse', apigateway.ResponseType.ACCESS_DENIED],
      ['Default4xxGatewayResponse', apigateway.ResponseType.DEFAULT_4XX],
      ['Default5xxGatewayResponse', apigateway.ResponseType.DEFAULT_5XX],
    ] as const) {
      this.api.addGatewayResponse(id, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': "'*'",
          'Access-Control-Allow-Headers': "'Content-Type,Authorization'",
        },
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpointOutput', {
      value: this.api.url,
      exportName: 'LandFinderApiEndpoint',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      exportName: 'LandFinderAlarmTopicArn',
      description: 'Subscribe an email or PagerDuty endpoint to this SNS topic to receive alarm notifications',
    });

    new cdk.CfnOutput(this, 'SearchQueueUrl', {
      value: searchJobsQueue.queueUrl,
      exportName: 'LandFinderSearchQueueUrl',
    });
  }
}
