import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'LandFinderUserPool', {
      userPoolName: 'landfinder-users',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create User Pool Client for the mobile app
    this.userPoolClient = new cognito.UserPoolClient(this, 'LandFinderAppClient', {
      userPool: this.userPool,
      userPoolClientName: 'landfinder-mobile-app',
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false, // No secret for mobile apps
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
    });

    // Create User Pool Domain for hosted UI (optional, but useful)
    const domain = this.userPool.addDomain('LandFinderDomain', {
      cognitoDomain: {
        domainPrefix: `landfinder-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolIdOutput', {
      value: this.userPool.userPoolId,
      exportName: 'LandFinderUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientIdOutput', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'LandFinderUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'UserPoolDomainOutput', {
      value: domain.domainName,
      exportName: 'LandFinderUserPoolDomain',
    });
  }
}
