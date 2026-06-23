import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

interface ScrapingStackProps extends cdk.StackProps {
  database: rds.DatabaseInstance;
  vpc: ec2.Vpc;
}

export class ScrapingStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly scrapingBucket: s3.Bucket;
  public readonly scrapingQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: ScrapingStackProps) {
    super(scope, id, props);

    const { database, vpc } = props;

    // S3 bucket for scraped data
    this.scrapingBucket = new s3.Bucket(this, 'ScrapingBucket', {
      bucketName: `landfinder-scraping-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'ExpireOldData',
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // SQS queue for scraping jobs
    this.scrapingQueue = new sqs.Queue(this, 'ScrapingQueue', {
      queueName: 'landfinder-scraping-queue',
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        queue: new sqs.Queue(this, 'ScrapingDLQ', {
          queueName: 'landfinder-scraping-dlq',
          retentionPeriod: cdk.Duration.days(14),
        }),
        maxReceiveCount: 3,
      },
    });

    // ECS Cluster
    this.cluster = new ecs.Cluster(this, 'ScrapingCluster', {
      clusterName: 'landfinder-scraping',
      vpc: vpc,
      enableFargateCapacityProviders: true,
    });

    // ECR Repository for scraper images
    const scraperRepo = new ecr.Repository(this, 'ScraperRepository', {
      repositoryName: 'landfinder-scrapers',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only 10 images',
        },
      ],
    });

    // Task execution role
    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'landfinder-scraper-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy'
        ),
      ],
    });

    // Task role with permissions
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'landfinder-scraper-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Grant permissions to task role
    this.scrapingBucket.grantReadWrite(taskRole);
    this.scrapingQueue.grantConsumeMessages(taskRole);
    database.secret!.grantRead(taskRole);

    // Bedrock permissions for AI analysis
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-*',
          `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-*`,
        ],
      })
    );

    // Cadastral Scraper Task Definition
    const cadastralTaskDef = new ecs.FargateTaskDefinition(
      this,
      'CadastralScraperTask',
      {
        family: 'landfinder-cadastral-scraper',
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    cadastralTaskDef.addContainer('CadastralScraper', {
      containerName: 'cadastral-scraper',
      image: ecs.ContainerImage.fromEcrRepository(scraperRepo, 'cadastral-latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'cadastral-scraper',
      }),
      environment: {
        DATABASE_SECRET_ARN: database.secret!.secretArn,
        S3_BUCKET: this.scrapingBucket.bucketName,
        AWS_REGION: cdk.Aws.REGION,
      },
    });

    // Water Rights Scraper Task Definition
    const waterRightsTaskDef = new ecs.FargateTaskDefinition(
      this,
      'WaterRightsScraperTask',
      {
        family: 'landfinder-water-rights-scraper',
        memoryLimitMiB: 2048,
        cpu: 1024,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    waterRightsTaskDef.addContainer('WaterRightsScraper', {
      containerName: 'water-rights-scraper',
      image: ecs.ContainerImage.fromEcrRepository(scraperRepo, 'water-rights-latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'water-rights-scraper',
      }),
      environment: {
        DATABASE_SECRET_ARN: database.secret!.secretArn,
        S3_BUCKET: this.scrapingBucket.bucketName,
        AWS_REGION: cdk.Aws.REGION,
      },
    });

    // Listings Scraper Task Definition
    const listingsTaskDef = new ecs.FargateTaskDefinition(
      this,
      'ListingsScraperTask',
      {
        family: 'landfinder-listings-scraper',
        memoryLimitMiB: 4096,
        cpu: 2048,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    listingsTaskDef.addContainer('ListingsScraper', {
      containerName: 'listings-scraper',
      image: ecs.ContainerImage.fromEcrRepository(scraperRepo, 'listings-latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'listings-scraper',
      }),
      environment: {
        DATABASE_SECRET_ARN: database.secret!.secretArn,
        S3_BUCKET: this.scrapingBucket.bucketName,
        AWS_REGION: cdk.Aws.REGION,
      },
    });

    // Step Functions state machine for orchestrating scraping
    const runCadastralScraper = new sfn_tasks.EcsRunTask(this, 'RunCadastralScraper', {
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      cluster: this.cluster,
      taskDefinition: cadastralTaskDef,
      launchTarget: new sfn_tasks.EcsFargateLaunchTarget(),
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    const runWaterRightsScraper = new sfn_tasks.EcsRunTask(
      this,
      'RunWaterRightsScraper',
      {
        integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
        cluster: this.cluster,
        taskDefinition: waterRightsTaskDef,
        launchTarget: new sfn_tasks.EcsFargateLaunchTarget(),
        subnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      }
    );

    const runListingsScraper = new sfn_tasks.EcsRunTask(this, 'RunListingsScraper', {
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      cluster: this.cluster,
      taskDefinition: listingsTaskDef,
      launchTarget: new sfn_tasks.EcsFargateLaunchTarget(),
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
    });

    // Define the workflow
    const parallelScrapers = new stepfunctions.Parallel(this, 'ParallelScrapers', {
      resultPath: '$.scrapingResults',
    });

    parallelScrapers.branch(runCadastralScraper);
    parallelScrapers.branch(runWaterRightsScraper);
    parallelScrapers.branch(runListingsScraper);

    const scrapingComplete = new stepfunctions.Succeed(this, 'ScrapingComplete');

    const definition = parallelScrapers.next(scrapingComplete);

    new stepfunctions.StateMachine(this, 'ScrapingStateMachine', {
      stateMachineName: 'landfinder-scraping-workflow',
      definition: definition,
      timeout: cdk.Duration.hours(2),
    });

    // Outputs
    new cdk.CfnOutput(this, 'ClusterArnOutput', {
      value: this.cluster.clusterArn,
      exportName: 'LandFinderScrapingClusterArn',
    });

    new cdk.CfnOutput(this, 'ScrapingBucketOutput', {
      value: this.scrapingBucket.bucketName,
      exportName: 'LandFinderScrapingBucket',
    });

    new cdk.CfnOutput(this, 'ScrapingQueueUrlOutput', {
      value: this.scrapingQueue.queueUrl,
      exportName: 'LandFinderScrapingQueueUrl',
    });

    new cdk.CfnOutput(this, 'ScraperRepoUriOutput', {
      value: scraperRepo.repositoryUri,
      exportName: 'LandFinderScraperRepoUri',
    });
  }
}
