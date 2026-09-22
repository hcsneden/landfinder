import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { type Construct } from 'constructs';

interface ScrapingStackProps extends cdk.StackProps {
  database: rds.DatabaseClusterFromSnapshot;
  vpc: ec2.Vpc;
}

interface ScraperSpec {
  name: string;
  cpu: number;
  memoryMiB: number;
}

const SCRAPERS: Record<string, ScraperSpec> = {
  cadastral: { name: 'cadastral', cpu: 1024, memoryMiB: 2048 },
  waterRights: { name: 'water-rights', cpu: 1024, memoryMiB: 2048 },
  huntingDistricts: { name: 'hunting-districts', cpu: 512, memoryMiB: 1024 },
  streamGauges: { name: 'stream-gauges', cpu: 512, memoryMiB: 1024 },
};

export class ScrapingStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly scrapingBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ScrapingStackProps) {
    super(scope, id, props);
    const { database, vpc } = props;

    this.scrapingBucket = new s3.Bucket(this, 'ScrapingBucket', {
      bucketName: `landfinder-scraping-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'ExpireOldData', expiration: cdk.Duration.days(90) }],
    });

    this.cluster = new ecs.Cluster(this, 'ScrapingCluster', {
      clusterName: 'landfinder-scraping',
      vpc,
      enableFargateCapacityProviders: true,
    });

    const scraperRepo = new ecr.Repository(this, 'ScraperRepository', {
      repositoryName: 'landfinder-scrapers',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [{ maxImageCount: 10, description: 'Keep only 10 images' }],
    });

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: 'landfinder-scraper-execution-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: 'landfinder-scraper-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    this.scrapingBucket.grantReadWrite(taskRole);
    database.secret!.grantRead(taskRole);

    const runScraper = (spec: ScraperSpec) => {
      const pascal = spec.name.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
      const taskDefinition = new ecs.FargateTaskDefinition(this, `${pascal}ScraperTask`, {
        family: `landfinder-${spec.name}-scraper`,
        cpu: spec.cpu,
        memoryLimitMiB: spec.memoryMiB,
        executionRole,
        taskRole,
      });
      taskDefinition.addContainer(`${pascal}Scraper`, {
        containerName: `${spec.name}-scraper`,
        image: ecs.ContainerImage.fromEcrRepository(scraperRepo, `${spec.name}-latest`),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: `${spec.name}-scraper` }),
        environment: {
          DATABASE_SECRET_ARN: database.secret!.secretArn,
          S3_BUCKET: this.scrapingBucket.bucketName,
          AWS_REGION: cdk.Aws.REGION,
        },
      });
      // A public subnet with a public IP instead of a NAT gateway. No inbound
      // rules exist, so nothing can reach the task.
      return new sfnTasks.EcsRunTask(this, `Run${pascal}Scraper`, {
        integrationPattern: stepfunctions.IntegrationPattern.RUN_JOB,
        cluster: this.cluster,
        taskDefinition,
        launchTarget: new sfnTasks.EcsFargateLaunchTarget(),
        subnets: { subnetType: ec2.SubnetType.PUBLIC },
        assignPublicIp: true,
      });
    };

    // Water rights are looked up for parcels the cadastral run loaded, so the
    // two run in sequence. The other scrapers are independent.
    const definition = new stepfunctions.Parallel(this, 'Scrapers')
      .branch(runScraper(SCRAPERS.cadastral!).next(runScraper(SCRAPERS.waterRights!)))
      .branch(runScraper(SCRAPERS.huntingDistricts!))
      .branch(runScraper(SCRAPERS.streamGauges!))
      .next(new stepfunctions.Succeed(this, 'ScrapingComplete'));

    new stepfunctions.StateMachine(this, 'ScrapingStateMachine', {
      stateMachineName: 'landfinder-scraping-workflow',
      definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(4),
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
