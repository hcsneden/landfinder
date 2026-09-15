# Cost Pause and Restore

Record of the AWS cost pause performed on 2026-08-13, and how to bring the
infrastructure back when you need it.

## Superseded 2026-09-15

The NAT Gateway restore below no longer applies. The infrastructure was
redeployed without a NAT at all:

- The database moved from RDS `landfinder-db` to Aurora Serverless v2
  `landfinder-aurora`, restored from snapshot `landfinder-db-pre-aurora-20260915`.
  Minimum capacity is 0 ACUs, so compute pauses after 10 idle minutes and only
  storage is billed while paused. `landfinder-db-warmup` runs every 12 hours so
  a paused instance never falls into the slower deep-sleep resume.
- The API Lambdas run outside the VPC and query Aurora through the RDS Data API
  (`services/api/shared/db.ts`). Parameters bound to `uuid` columns need an
  explicit `::uuid` cast, and arrays are sent as text with a `::type[]` cast.
- The scraper tasks run in public subnets with a public IP and no inbound rules,
  and still connect to Aurora with `pg` from inside the VPC.
- RDS `landfinder-db` was stopped, not deleted. A follow-up deploy removes it
  (final snapshot), the legacy exports in `database-stack.ts`, the old `Private`
  subnets and the unused Lambda security group. Do it within 7 days of stopping,
  or AWS restarts the instance and billing resumes.
- Deploys need `ALLOWED_ORIGINS` set, or API Gateway CORS falls back to
  localhost and the CloudFront site cannot call the API:
  `ALLOWED_ORIGINS=https://d3fq5dh8c0d57s.cloudfront.net,http://localhost:5173`.

## Summary

LandFinder infrastructure runs in AWS account `444311061836`, region
`us-west-2`, under the `landfinder-admin` CLI profile. As of August 2026 it was
costing roughly $55/month while completely idle. No ECS tasks, Step Functions
executions, EC2 instances, or scheduled scraper rules were running. Every dollar
came from standing infrastructure billed by the hour.

## What was costing money

| Item | Aug 1-13 | Approx monthly |
|---|---|---|
| NAT Gateway hours | $12.96 | $32.00 |
| RDS `landfinder-db` (db.t3.micro) | $5.18 | $13.00 |
| Public IPv4 address (the NAT Gateway EIP) | $1.44 | $3.60 |
| RDS gp3 storage (20 GB) and backups | $0.98 | $2.40 |
| Secrets Manager (2 secrets) | $0.31 | $0.80 |
| CloudWatch alarms | $0.35 | $0.90 |

Unrelated charges in the same account, left untouched: a toll-free phone number
under AWS End User Messaging in `us-east-1` (about $2/month), and a small
`windy` / Amplify footprint in `us-east-2` (a stopped `t2.micro`, its 8 GB gp3
volume, and DynamoDB autoscaling alarms).

## Actions taken

1. Stopped the RDS instance.

   ```bash
   AWS_PROFILE=landfinder-admin aws rds stop-db-instance \
     --region us-west-2 --db-instance-identifier landfinder-db
   ```

2. Deleted the NAT Gateway `nat-0daa561ce47120780`.

   ```bash
   AWS_PROFILE=landfinder-admin aws ec2 delete-nat-gateway \
     --region us-west-2 --nat-gateway-id nat-0daa561ce47120780
   ```

3. Released the orphaned Elastic IP `52.25.113.27`
   (`eipalloc-0e4f4a16e14048375`) that the NAT Gateway had been using. AWS
   charges for every allocated public IPv4 address, associated or not.

   ```bash
   AWS_PROFILE=landfinder-admin aws ec2 release-address \
     --region us-west-2 --allocation-id eipalloc-0e4f4a16e14048375
   ```

Expected remaining spend is roughly $6-7/month: RDS storage and backups,
Secrets Manager, and CloudWatch alarms.

Nothing was destroyed. All five CloudFormation stacks
(`LandFinderDatabaseStack`, `LandFinderApiStack`, `LandFinderAuthStack`,
`LandFinderScrapingStack`, `LandFinderWebStack`) still exist, the RDS data is
intact, and the Cognito user pool is untouched.

## Current state

- RDS `landfinder-db` is **stopped**. Data and the 20 GB volume are preserved.
- The VPC `vpc-02ddfdd497fb8384b` has **no NAT Gateway**. Resources in the
  `PRIVATE_WITH_EGRESS` subnets have no outbound internet access. Anything that
  calls an external API from a private subnet, which includes the scrapers and
  the Bedrock-backed Lambdas, will time out until the NAT is restored.
- CloudFormation state is now drifted from reality for the NAT Gateway and its
  EIP. This matters for the restore procedure below.

## The 7-day RDS auto-restart

AWS automatically restarts a stopped RDS instance after **7 days**. It will come
back online on its own around **2026-08-20** and resume billing at about
$13/month unless you stop it again.

To keep it stopped, re-run the stop command weekly:

```bash
AWS_PROFILE=landfinder-admin aws rds stop-db-instance \
  --region us-west-2 --db-instance-identifier landfinder-db
```

Check whether it has restarted:

```bash
AWS_PROFILE=landfinder-admin aws rds describe-db-instances \
  --region us-west-2 --db-instance-identifier landfinder-db \
  --query 'DBInstances[0].DBInstanceStatus' --output text
```

If you want this to stop being a chore, the options are a scheduled Lambda or
EventBridge rule that re-stops it, or taking a final snapshot and deleting the
instance outright. Deleting with a snapshot drops the cost to a few cents per
month and the instance can be restored from the snapshot later, though it comes
back with a new endpoint hostname.

## Restore

### Step 1: Start the database

```bash
AWS_PROFILE=landfinder-admin aws rds start-db-instance \
  --region us-west-2 --db-instance-identifier landfinder-db
```

It takes a few minutes to reach `available`. The endpoint hostname and the
Secrets Manager credentials are unchanged, so nothing in the app config needs
updating.

### Step 2: Recreate the NAT Gateway

The NAT Gateway is defined in `infrastructure/lib/database-stack.ts` as
`natGateways: 1` on the `LandFinderVpc` construct. Because it was deleted
outside CloudFormation, a plain `cdk deploy` will report no changes and will
**not** bring it back. CloudFormation does not self-heal drift.

Use this two-step cycle instead. First, edit
`infrastructure/lib/database-stack.ts` and set the NAT count to zero:

```ts
this.vpc = new ec2.Vpc(this, 'LandFinderVpc', {
  vpcName: 'landfinder-vpc',
  maxAzs: 2,
  natGateways: 0,
  ...
```

Deploy so CloudFormation's state catches up with reality:

```bash
cd infrastructure
AWS_PROFILE=landfinder-admin npx cdk deploy LandFinderDatabaseStack \
  --require-approval never
```

Then set it back to `natGateways: 1` and deploy again:

```bash
AWS_PROFILE=landfinder-admin npx cdk deploy LandFinderDatabaseStack \
  --require-approval never
```

CDK provisions a fresh NAT Gateway with a new Elastic IP and rewrites the
private subnet routes. Note the new public IP will differ from `52.25.113.27`,
so if any external service allowlists your outbound IP it needs updating.

Setting `natGateways: 0` also removes the `PRIVATE_WITH_EGRESS` subnets' default
route. If the intermediate deploy fails on a dependency, deploy the whole set
with `--all` rather than the database stack alone.

### Step 3: Redeploy everything else

```bash
./deploy.sh
```

This reads credentials from `.env`, writes the `landfinder-admin` profile,
bootstraps CDK, and runs `cdk deploy --all`.

### Step 4: Verify

```bash
AWS_PROFILE=landfinder-admin aws rds describe-db-instances \
  --region us-west-2 --db-instance-identifier landfinder-db \
  --query 'DBInstances[0].DBInstanceStatus' --output text

AWS_PROFILE=landfinder-admin aws ec2 describe-nat-gateways \
  --region us-west-2 --filter Name=state,Values=available \
  --query 'NatGateways[].[NatGatewayId,NatGatewayAddresses[0].PublicIp]' \
  --output text
```

Then trigger a scraper through the Step Functions state machine
`landfinder-scraping-workflow` to confirm private-subnet egress works.

## Checking costs later

Cost Explorer is available on the `landfinder-admin` profile but **not** on the
`default` profile, whose `windy-admin` user lacks `ce:GetCostAndUsage` and most
describe permissions. Always set the profile explicitly.

```bash
AWS_PROFILE=landfinder-admin aws ce get-cost-and-usage \
  --region us-east-1 \
  --time-period Start=2026-08-01,End=2026-09-01 \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=USAGE_TYPE --output json
```

Grouping by `USAGE_TYPE` rather than `SERVICE` is what made the NAT Gateway
visible. At the service level it was hidden inside a generic "EC2 - Other" line.
