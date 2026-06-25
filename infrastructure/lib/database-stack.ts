import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export class DatabaseStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly database: rds.DatabaseInstance;
  public readonly usersTable: dynamodb.Table;
  public readonly searchesTable: dynamodb.Table;
  public readonly databaseSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC for database
    this.vpc = new ec2.Vpc(this, 'LandFinderVpc', {
      vpcName: 'landfinder-vpc',
      maxAzs: 2,
      natGateways: 1, // Cost optimization for MVP
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

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

    // Create RDS PostgreSQL instance
    this.database = new rds.DatabaseInstance(this, 'LandFinderDatabase', {
      instanceIdentifier: 'landfinder-db',
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_9,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO), // MVP: t3.micro
      vpc: this.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
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
      value: this.database.instanceEndpoint.hostname,
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
