import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

// Manual snapshot of the RDS instance that the Aurora cluster is restored from.
// Must exist before the first deploy that creates the cluster. See docs/cost-pause-restore.md.
const AURORA_SOURCE_SNAPSHOT = 'landfinder-db-pre-aurora-20260915';

export class DatabaseStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly database: rds.DatabaseClusterFromSnapshot;
  public readonly usersTable: dynamodb.Table;
  public readonly searchesTable: dynamodb.Table;
  public readonly databaseSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // No NAT. Lambdas run outside the VPC and reach Aurora through the RDS Data API,
    // and the scraper tasks run in public subnets with a public IP.
    // "Private" was PRIVATE_WITH_EGRESS behind a NAT Gateway. It is isolated now and
    // only kept so the API stack's old subnet imports resolve. Remove with legacyInstance.
    this.vpc = new ec2.Vpc(this, 'LandFinderVpc', {
      vpcName: 'landfinder-vpc',
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });
    const databaseSubnets = { subnetGroupName: 'Isolated' };

    // Security group for RDS
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc: this.vpc,
      securityGroupName: 'landfinder-db-sg',
      description: 'Security group for LandFinder RDS PostgreSQL',
      allowAllOutbound: true,
    });

    // Allow connections from Lambda and ECS in private subnets
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL from VPC'
    );

    // Original RDS instance. No longer used by the app, kept only until the Aurora
    // cluster is verified, then removed (final snapshot) in a follow-up deploy.
    const legacyInstance = new rds.DatabaseInstance(this, 'LandFinderDatabase', {
      instanceIdentifier: 'landfinder-db',
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_9,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO), // MVP: t3.micro
      vpc: this.vpc,
      vpcSubnets: databaseSubnets,
      securityGroups: [dbSecurityGroup],
      databaseName: 'landfinder',
      credentials: rds.Credentials.fromGeneratedSecret('landfinder_admin', {
        secretName: 'landfinder/db/credentials',
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageType: rds.StorageType.GP3,
      multiAz: false, // MVP: single AZ
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // The API and scraping stacks import these until they are redeployed against Aurora.
    // Keeping them lets this stack deploy first. Remove together with legacyInstance.
    const legacyExports: Array<[string, string]> = [
      ['ExportsOutputFnGetAttLandFinderDatabaseA23662A9EndpointAddress796D9364', legacyInstance.dbInstanceEndpointAddress],
      ['ExportsOutputFnGetAttLandFinderDatabaseA23662A9EndpointPortA0C9B7A3', legacyInstance.dbInstanceEndpointPort],
      ['ExportsOutputRefLandFinderDatabaseSecretAttachment9D9982D639AF7956', legacyInstance.secret!.secretArn],
      ['ExportsOutputRefLandFinderVpcPrivateSubnet1Subnet66404AE1E296EC9A', this.vpc.selectSubnets({ subnetGroupName: 'Private' }).subnetIds[0]],
      ['ExportsOutputRefLandFinderVpcPrivateSubnet2Subnet3415C61562EF5D33', this.vpc.selectSubnets({ subnetGroupName: 'Private' }).subnetIds[1]],
    ];
    for (const [outputId, value] of legacyExports) {
      new cdk.CfnOutput(this, outputId, { value, exportName: `${this.stackName}:${outputId}` });
    }

    // Aurora Serverless v2, restored from a snapshot of the instance above.
    // Min capacity 0 pauses compute after 10 idle minutes. Resume takes ~15s,
    // 30s+ after a day paused, so the API stack pings it every 12 hours.
    const auroraSecret = new rds.DatabaseSecret(this, 'AuroraSecret', {
      username: 'landfinder_admin',
      dbname: 'landfinder',
      secretName: 'landfinder/aurora/credentials',
    });

    this.database = new rds.DatabaseClusterFromSnapshot(this, 'LandFinderAurora', {
      clusterIdentifier: 'landfinder-aurora',
      snapshotIdentifier: `arn:aws:rds:${this.region}:${this.account}:snapshot:${AURORA_SOURCE_SNAPSHOT}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      snapshotCredentials: rds.SnapshotCredentials.fromSecret(auroraSecret),
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        instanceIdentifier: 'landfinder-aurora-writer',
      }),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: cdk.Duration.minutes(10),
      enableDataApi: true,
      vpc: this.vpc,
      vpcSubnets: databaseSubnets,
      securityGroups: [dbSecurityGroup],
      backup: { retention: cdk.Duration.days(7) },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    this.databaseSecret = this.database.secret!;

    // DynamoDB table for user data (fast access patterns)
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'landfinder-users',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
    });

    // Add GSI for email lookups
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: {
        name: 'email',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // DynamoDB table for search jobs
    this.searchesTable = new dynamodb.Table(this, 'SearchesTable', {
      tableName: 'landfinder-searches',
      partitionKey: {
        name: 'searchId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // Add GSI for user searches
    this.searchesTable.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'VpcIdOutput', {
      value: this.vpc.vpcId,
      exportName: 'LandFinderVpcId',
    });

    new cdk.CfnOutput(this, 'DatabaseEndpointOutput', {
      value: this.database.clusterEndpoint.hostname,
      exportName: 'LandFinderDatabaseEndpoint',
    });

    new cdk.CfnOutput(this, 'DatabaseSecretArnOutput', {
      value: this.databaseSecret.secretArn,
      exportName: 'LandFinderDatabaseSecretArn',
    });

    new cdk.CfnOutput(this, 'UsersTableNameOutput', {
      value: this.usersTable.tableName,
      exportName: 'LandFinderUsersTableName',
    });

    new cdk.CfnOutput(this, 'SearchesTableNameOutput', {
      value: this.searchesTable.tableName,
      exportName: 'LandFinderSearchesTableName',
    });
  }
}
