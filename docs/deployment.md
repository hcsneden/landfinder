# Deploying LandFinder to AWS

## Prerequisites

Install the following before starting:

- [Node.js](https://nodejs.org/) v18 or higher
- [AWS CLI](https://aws.amazon.com/cli/) — `brew install awscli`
- [Docker](https://www.docker.com/) — needed to bundle Lambda functions
- An AWS account with admin access (or an IAM user with permissions to create IAM roles, Lambda, RDS, Cognito, ECS, Step Functions, S3, DynamoDB, SQS, ECR, and Bedrock)

---

## Step 1 — Configure AWS credentials

```bash
aws configure
```

Enter your AWS Access Key ID, Secret Access Key, and set the default region to `us-west-2`. Verify it worked:

```bash
aws sts get-caller-identity
```

You should see your account ID and user ARN.

---

## Step 2 — Bootstrap CDK

CDK needs to create a small set of resources in your account the first time it runs (an S3 bucket for assets and some IAM roles). This is a one-time step per account/region.

```bash
cd infrastructure
npm install
npx cdk bootstrap aws://YOUR_ACCOUNT_ID/us-west-2
```

Replace `YOUR_ACCOUNT_ID` with your 12-digit AWS account ID (visible in the output of `aws sts get-caller-identity`).

---

## Step 3 — Preview the changes

Before deploying, you can see exactly what CDK will create:

```bash
npm run diff
```

---

## Step 4 — Deploy all stacks

```bash
npm run deploy
```

This deploys all four stacks in dependency order:

| Stack | What it creates | Approx. time |
|---|---|---|
| `LandFinderAuthStack` | Cognito User Pool | ~2 min |
| `LandFinderDatabaseStack` | VPC, RDS PostgreSQL, DynamoDB tables | ~15 min |
| `LandFinderApiStack` | API Gateway, Lambda functions | ~3 min |
| `LandFinderScrapingStack` | ECS cluster, ECR repo, SQS, S3, Step Functions | ~5 min |

CDK will prompt you to confirm IAM and security group changes — type `y` to approve.

When complete, CDK prints important output values (API endpoint URL, Cognito pool IDs, etc.). Save these — you'll need them to configure the mobile app.

You can also deploy a single stack if needed:

```bash
npm run deploy:auth
npm run deploy:database
npm run deploy:api
```

---

## Step 5 — Apply the database schema

The RDS instance is in a private subnet with no public internet access. To run the schema migration you need to connect through AWS Systems Manager (no bastion host required).

### Option A — RDS Query Editor (easiest)

1. Go to **AWS Console → RDS → Query Editor**
2. Select the `landfinder-db` instance
3. Choose **Connect with AWS Secrets Manager** and select the `landfinder/db/credentials` secret
4. Paste the contents of `database/001_initial_schema.sql` and run it

### Option B — SSM port forwarding from your local machine

```bash
# Find the RDS endpoint from CDK output or the console
DB_HOST=landfinder-db.xxxx.us-west-2.rds.amazonaws.com

# Start an SSM tunnel (requires an EC2 instance or you can use RDS Proxy)
aws ssm start-session \
  --target INSTANCE_ID \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$DB_HOST,portNumber=5432,localPortNumber=5433"

# In another terminal, connect via psql
psql -h localhost -p 5433 -U landfinder_admin -d landfinder \
  -f database/001_initial_schema.sql
```

---

## Step 6 — Configure the mobile app

After deployment, update the mobile app with the values from CDK output:

| Value | Where to put it |
|---|---|
| API Gateway URL | `apps/mobile` environment config |
| Cognito User Pool ID | `apps/mobile` environment config |
| Cognito User Pool Client ID | `apps/mobile` environment config |

---

## Step 7 — Build and push scraper images (when ready)

The scraping infrastructure (ECS, Step Functions) is deployed, but the container images don't exist yet. When the scrapers are ready to run:

```bash
# Get the ECR repo URI from CDK output
ECR_URI=YOUR_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/landfinder-scrapers

# Authenticate Docker to ECR
aws ecr get-login-password --region us-west-2 | \
  docker login --username AWS --password-stdin $ECR_URI

# Build and push each scraper
docker build -t $ECR_URI:cadastral-latest -f services/scrapers/cadastral/Dockerfile .
docker push $ECR_URI:cadastral-latest

docker build -t $ECR_URI:water-rights-latest -f services/scrapers/water-rights/Dockerfile .
docker push $ECR_URI:water-rights-latest

docker build -t $ECR_URI:listings-latest -f services/scrapers/listings/Dockerfile .
docker push $ECR_URI:listings-latest
```

Once images are pushed, trigger the scraping workflow from the AWS Console under **Step Functions → landfinder-scraping-workflow**.

---

## Tearing down

To delete all AWS resources (this will destroy the database — make sure to take a snapshot first):

```bash
npm run destroy
```

Note: The RDS instance has `removalPolicy: SNAPSHOT` set, so destroying it will take a final snapshot rather than deleting data outright.

---

## Known gaps to fix before production

- **Lambda VPC configuration** — The API Lambda functions are not currently placed inside the VPC, which means they cannot reach the RDS database. This needs to be added to `infrastructure/lib/api-stack.ts` before the API will work end-to-end.
- **`deletionProtection: false`** on RDS — intentionally off for development. Set to `true` before going live.
- **`multiAz: false`** on RDS — single AZ for cost during MVP. Enable for production.
