#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AuthStack } from '../lib/auth-stack';
import { DatabaseStack } from '../lib/database-stack';
import { ApiStack } from '../lib/api-stack';
import { ScrapingStack } from '../lib/scraping-stack';
import { WebStack } from '../lib/web-stack';

const LOCAL_ORIGINS = ['http://localhost:5173', 'http://localhost:3001'];

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-west-2',
};

// Comma-separated list of browser origins allowed to call the API. deploy.sh
// sets it from the CloudFront URL. Without it only local development works.
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()) ?? LOCAL_ORIGINS;

const authStack = new AuthStack(app, 'LandFinderAuthStack', {
  env,
  description: 'LandFinder authentication: Cognito user pool',
});

const databaseStack = new DatabaseStack(app, 'LandFinderDatabaseStack', {
  env,
  description: 'LandFinder data: Aurora Serverless v2 and DynamoDB',
});

const apiStack = new ApiStack(app, 'LandFinderApiStack', {
  env,
  description: 'LandFinder API: API Gateway and Lambda',
  userPool: authStack.userPool,
  userPoolClient: authStack.userPoolClient,
  database: databaseStack.database,
  searchesTable: databaseStack.searchesTable,
  parcelCacheTable: databaseStack.parcelCacheTable,
  allowedOrigins,
  geocoderContactEmail: process.env.GEOCODER_CONTACT_EMAIL ?? '',
});

const scrapingStack = new ScrapingStack(app, 'LandFinderScrapingStack', {
  env,
  description: 'LandFinder scrapers: ECS Fargate tasks and Step Functions',
  database: databaseStack.database,
  vpc: databaseStack.vpc,
});

new WebStack(app, 'LandFinderWebStack', {
  env,
  description: 'LandFinder web app: S3 and CloudFront',
});

apiStack.addDependency(authStack);
apiStack.addDependency(databaseStack);
scrapingStack.addDependency(databaseStack);
