# Deployment

## Prerequisites

- Node.js 20
- AWS CLI with credentials for the target account
- Docker, for bundling Lambda functions and building scraper images
- A manual RDS snapshot named in `infrastructure/lib/database-stack.ts`. The
  Aurora cluster is created from it.

## First deploy

1. Bootstrap CDK once per account and region:

   ```bash
   cd infrastructure && npm install
   npx cdk bootstrap aws://ACCOUNT_ID/us-west-2
   ```

2. Deploy every stack. The script reads `KEY=` and `SECRET=` from `.env` at the
   repository root, writes the `landfinder-admin` profile, builds the web app,
   and sets `ALLOWED_ORIGINS` from the CloudFront URL when one exists:

   ```bash
   ./deploy.sh
   ```

   On the very first run the web stack does not exist yet, so CORS allows only
   local origins. Run `./deploy.sh LandFinderApiStack` again after it finishes.

3. Set the Serper API key. The stack creates the secret with an empty value:

   ```bash
   aws secretsmanager put-secret-value --secret-id landfinder/serper \
     --secret-string '{"apiKey":"YOUR_KEY"}'
   ```

4. Apply the schema. The migration Lambda runs every file in `database/` in
   order. Each statement is idempotent, so it is safe to rerun:

   ```bash
   aws lambda invoke --function-name landfinder-migration /dev/stdout
   ```

5. Optionally set `GEOCODER_CONTACT_EMAIL` in the environment before deploying.
   Nominatim's usage policy asks for a contact address in the User-Agent.

## Web app configuration

`apps/web/.env.local`:

```
VITE_API_URL=https://API_ID.execute-api.us-west-2.amazonaws.com/v1
VITE_DEMO_EMAIL=        # optional demo account
VITE_DEMO_PASSWORD=
```

The mobile app reads `EXPO_PUBLIC_API_URL`.

## Scraper images

One Dockerfile builds every scraper. Build and push each one from the
repository root, then start the Step Functions state machine
`landfinder-scraping-workflow` from the console or CLI:

```bash
ECR=ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com/landfinder-scrapers
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin $ECR
for scraper in cadastral water-rights hunting-districts stream-gauges; do
  docker build -f services/scrapers/Dockerfile --build-arg SCRAPER=$scraper -t $ECR:$scraper-latest .
  docker push $ECR:$scraper-latest
done
```

The workflow runs cadastral then water rights in sequence, with hunting
districts and stream gauges in parallel.

## Tearing down

`npm run destroy` in `infrastructure/` removes every stack. The Aurora cluster
has deletion protection and a snapshot removal policy, so the database is
snapshotted rather than deleted. The Cognito user pool is retained.
