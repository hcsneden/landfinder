import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { type Construct } from 'constructs';

// Manual snapshot of the RDS instance the Aurora cluster was restored from.
// It must exist before the first deploy that creates the cluster.
const AURORA_SOURCE_SNAPSHOT = 'landfinder-db-pre-aurora-20260915';

export class DatabaseStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly database: rds.DatabaseClusterFromSnapshot;
  public readonly searchesTable: dynamodb.Table;
  public readonly parcelCacheTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // No NAT gateway. The API Lambdas run outside the VPC and use the RDS Data
    // API, and the scraper tasks run in public subnets with a public IP.
    // The "Private" subnet group is empty but stays: CDK allocates subnet CIDRs
    // in order, and removing it would renumber the isolated subnets Aurora uses.
    this.vpc = new ec2.Vpc(this, 'LandFinderVpc', {
      vpcName: 'landfinder-vpc',
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { cidrMask: 24, name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'Private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        { cidrMask: 24, name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: 'landfinder-db-sg',
      description: 'Aurora access from inside the VPC',
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(ec2.Peer.ipv4(this.vpc.vpcCidrBlock), ec2.Port.tcp(5432), 'PostgreSQL from VPC');

    const auroraSecret = new rds.DatabaseSecret(this, 'AuroraSecret', {
      username: 'landfinder_admin',
      dbname: 'landfinder',
      secretName: 'landfinder/aurora/credentials',
    });

    // Minimum capacity 0 pauses compute after 10 idle minutes. Resume takes
    // about 20 seconds, so the API stack pings the cluster on a schedule and
    // the web app calls GET /warmup on load.
    this.database = new rds.DatabaseClusterFromSnapshot(this, 'LandFinderAurora', {
      clusterIdentifier: 'landfinder-aurora',
      snapshotIdentifier: `arn:aws:rds:${this.region}:${this.account}:snapshot:${AURORA_SOURCE_SNAPSHOT}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({ version: rds.AuroraPostgresEngineVersion.VER_16_13 }),
      snapshotCredentials: rds.SnapshotCredentials.fromSecret(auroraSecret),
      writer: rds.ClusterInstance.serverlessV2('Writer', { instanceIdentifier: 'landfinder-aurora-writer' }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: cdk.Duration.minutes(10),
      enableDataApi: true,
      vpc: this.vpc,
      vpcSubnets: { subnetGroupName: 'Isolated' },
      securityGroups: [dbSecurityGroup],
      backup: { retention: cdk.Duration.days(7) },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // Search jobs expire through the ttl attribute, which is why they live
    // here rather than in Postgres.
    this.searchesTable = new dynamodb.Table(this, 'SearchesTable', {
      tableName: 'landfinder-searches',
      partitionKey: { name: 'searchId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });
    this.searchesTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
    });

    // Parcel records and per-source enrichment, cached so a repeat view never
    // wakes Aurora. Every entry is regenerable from Postgres and the upstream
    // services, so DESTROY is safe and no backup is needed.
    this.parcelCacheTable = new dynamodb.Table(this, 'ParcelCacheTable', {
      tableName: 'landfinder-parcel-cache',
      partitionKey: { name: 'parcelId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    new cdk.CfnOutput(this, 'VpcIdOutput', { value: this.vpc.vpcId, exportName: 'LandFinderVpcId' });
    new cdk.CfnOutput(this, 'DatabaseEndpointOutput', {
      value: this.database.clusterEndpoint.hostname,
      exportName: 'LandFinderDatabaseEndpoint',
    });
    new cdk.CfnOutput(this, 'DatabaseSecretArnOutput', {
      value: this.database.secret!.secretArn,
      exportName: 'LandFinderDatabaseSecretArn',
    });
    new cdk.CfnOutput(this, 'SearchesTableNameOutput', {
      value: this.searchesTable.tableName,
      exportName: 'LandFinderSearchesTableName',
    });
  }
}
