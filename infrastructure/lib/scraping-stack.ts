import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfn_tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

interface ScrapingStackProps extends cdk.StackProps {
  database: rds.DatabaseClusterFromSnapshot;
  vpc: ec2.Vpc;
}

export class ScrapingStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly scrapingBucket: s3.Bucket;

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

    // No listings scraper. Aggregating listing feeds needs a licensed MLS or partner
    // feed we do not have, so for-sale status comes from the per-parcel check in
    // services/api/shared/listingStatus.ts instead. The `listings` table stays for a
    // future licensed feed; nothing writes to it today.

    // Hunting Districts Scraper Task Definition (run weekly — districts rarely change)
    const huntingDistrictsTaskDef = new ecs.FargateTaskDefinition(
      this,
      'HuntingDistrictsScraperTask',
      {
        family: 'landfinder-hunting-districts-scraper',
        memoryLimitMiB: 1024,
        cpu: 512,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    huntingDistrictsTaskDef.addContainer('HuntingDistrictsScraper', {
      containerName: 'hunting-districts-scraper',
      image: ecs.ContainerImage.fromEcrRepository(scraperRepo, 'hunting-districts-latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hunting-districts-scraper',
      }),
      environment: {
        DATABASE_SECRET_ARN: database.secret!.secretArn,
        S3_BUCKET: this.scrapingBucket.bucketName,
        AWS_REGION: cdk.Aws.REGION,
      },
    });

    // Stream Gauges Scraper Task Definition (run weekly — gauge locations rarely change)
    const streamGaugesTaskDef = new ecs.FargateTaskDefinition(
      this,
      'StreamGaugesScraperTask',
      {
        family: 'landfinder-stream-gauges-scraper',
        memoryLimitMiB: 1024,
        cpu: 512,
        executionRole: executionRole,
        taskRole: taskRole,
      }
    );

    streamGaugesTaskDef.addContainer('StreamGaugesScraper', {
      containerName: 'stream-gauges-scraper',
      image: ecs.ContainerImage.fromEcrRepository(scraperRepo, 'stream-gauges-latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'stream-gauges-scraper',
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
      // Public subnet with a public IP instead of a NAT. No inbound rules, so nothing can reach the task.
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
    });

    const runWaterRightsScraper = new sfn_tasks.EcsRunTask(
      this,
      'RunWaterRightsScraper',
      {
        integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
        cluster: this.cluster,
        taskDefinition: waterRightsTaskDef,
        launchTarget: new sfn_tasks.EcsFargateLaunchTarget(),
        subnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
      }
    );

    const runHuntingDistrictsScraper = new sfn_tasks.EcsRunTask(this, 'RunHuntingDistrictsScraper', {
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      cluster: this.cluster,
      taskDefinition: huntingDistrictsTaskDef,
      launchTarget: new sfn_tasks.EcsFargateLaunchTarget(),
      // Public subnet with a public IP instead of a NAT. No inbound rules, so nothing can reach the task.
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
    });

    const runStreamGaugesScraper = new sfn_tasks.EcsRunTask(this, 'RunStreamGaugesScraper', {
      integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
      cluster: this.cluster,
      taskDefinition: streamGaugesTaskDef,
      launchTarget: new sfn_tasks.EcsFargateLaunchTarget(),
      // Public subnet with a public IP instead of a NAT. No inbound rules, so nothing can reach the task.
      subnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true,
    });

    // Define the workflow
    const parallelScrapers = new stepfunctions.Parallel(this, 'ParallelScrapers', {
      resultPath: '$.scrapingResults',
    });

    parallelScrapers.branch(runCadastralScraper);
    parallelScrapers.branch(runWaterRightsScraper);
    parallelScrapers.branch(runHuntingDistrictsScraper);
    parallelScrapers.branch(runStreamGaugesScraper);

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

    new cdk.CfnOutput(this, 'ScraperRepoUriOutput', {
      value: scraperRepo.repositoryUri,
      exportName: 'LandFinderScraperRepoUri',
    });
  }
}
