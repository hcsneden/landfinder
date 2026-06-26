#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ApiStack } from '../lib/api-stack';
import { ScrapingStack } from '../lib/scraping-stack';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
};

// Authentication stack (Cognito)
const authStack = new AuthStack(app, 'LandFinderAuthStack', {
  env,
  description: 'LandFinder Authentication - Cognito User Pool',
});

// Database stack (RDS PostgreSQL + DynamoDB)
const databaseStack = new DatabaseStack(app, 'LandFinderDatabaseStack', {
  env,
  description: 'LandFinder Database - RDS PostgreSQL and DynamoDB',
});

// CORS origins: set ALLOWED_ORIGINS env var to a comma-separated list of origins before deploying.
// Example: ALLOWED_ORIGINS=https://app.landfinder.com,https://www.landfinder.com
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3001']; // local dev

// API stack (API Gateway + Lambda)
const apiStack = new ApiStack(app, 'LandFinderApiStack', {
  env,
  description: 'LandFinder API - API Gateway and Lambda functions',
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  database: databaseStack.database,
  vpc: databaseStack.vpc,
  usersTable: databaseStack.usersTable,
  searchesTable: databaseStack.searchesTable,
  allowedOrigins,
});

// Scraping stack (ECS Fargate + Step Functions)
const scrapingStack = new ScrapingStack(app, 'LandFinderScrapingStack', {
  env,
  description: 'LandFinder Scraping - ECS Fargate workers and Step Functions',
  database: databaseStack.database,
  vpc: databaseStack.vpc,
});

// Web hosting stack (S3 + CloudFront)
const webStack = new WebStack(app, 'LandFinderWebStack', {
  env,
  description: 'LandFinder Web - S3 + CloudFront static hosting',
});

// Add dependencies
apiStack.addDependency(authStack);
apiStack.addDependency(databaseStack);
scrapingStack.addDependency(databaseStack);

// Output important values
new cdk.CfnOutput(authStack, 'UserPoolId', {
  value: authStack.userPool.userPoolId,
  description: 'Cognito User Pool ID',
});

new cdk.CfnOutput(authStack, 'UserPoolClientId', {
  value: authStack.userPoolClient.userPoolClientId,
  description: 'Cognito User Pool Client ID',
});
