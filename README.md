# Last Best Land

A full-stack application helping users navigate the land buying process in Montana. Find parcels, view water rights, and aggregate listings from multiple sources - all powered by AI.

## Features (Phase 1)

- **User Authentication** - Secure login/registration via AWS Cognito
- **Land Search** - Search Montana parcels by county, acreage, price, and water rights
- **Parcel Details** - View property ID, geo ID, boundaries, and location on a map
- **Water Rights** - DNRC water rights data linked to parcels
- **Listing Aggregation** - Consolidated listings from LandWatch, Land.com, and more
- **AI Insights** - Bedrock-powered analysis of properties and water rights

## Tech Stack

### Frontend
- React Native + Expo (iOS, Android, Web)
- Expo Router (file-based navigation)
- TanStack Query (data fetching)
- Zustand (state management)

### Backend
- AWS Lambda (API endpoints)
- AWS ECS Fargate (web scrapers)
- AWS Step Functions (orchestration)
- AWS Bedrock (AI analysis)

### Database
- PostgreSQL + PostGIS (RDS)
- DynamoDB (user sessions, search jobs)
- S3 (scraped data, images)

### Infrastructure
- AWS CDK (TypeScript)
- AWS Cognito (authentication)

## Project Structure

```
landfinder/
├── apps/
│   └── mobile/              # React Native + Expo app
├── packages/
│   └── shared/              # Shared types and utilities
├── services/
│   ├── api/                 # Lambda function handlers
│   └── scrapers/            # ECS scraper workers
├── infrastructure/          # AWS CDK stacks
└── database/                # SQL migrations
```

## Prerequisites

- Node.js 18+
- AWS CLI configured with credentials
- Expo CLI (`npm install -g expo-cli`)
- Docker (for ECS scrapers)

## Getting Started

### 1. Install Dependencies

```bash
cd landfinder
npm install
```

### 2. Deploy AWS Infrastructure

```bash
cd infrastructure
npm install
npm run cdk bootstrap  # First time only
npm run deploy
```

This deploys:
- Cognito User Pool
- RDS PostgreSQL database
- DynamoDB tables
- API Gateway + Lambda
- ECS cluster for scrapers
- S3 buckets

### 3. Run Database Migrations

Connect to RDS and run:

```bash
psql -h <rds-endpoint> -U landfinder_admin -d landfinder -f database/001_initial_schema.sql
```

### 4. Configure Mobile App

Create `apps/mobile/.env`:

```env
EXPO_PUBLIC_API_URL=https://<api-gateway-id>.execute-api.us-west-2.amazonaws.com/v1
```

### 5. Run the Mobile App

```bash
npm run mobile
```

Or for specific platforms:

```bash
npm run mobile:ios
npm run mobile:android
npm run mobile:web
```

## Data Sources

### Montana Cadastral
- URL: https://svc.mt.gov/msl/cadastral
- Data: Parcel boundaries, ownership, tax info
- Access: ArcGIS REST API

### DNRC Water Rights
- URL: https://wrqs.dnrc.mt.gov
- Data: Water rights records (400k+)
- Access: Web scraping

### Listing Sources
- LandWatch: https://landwatch.com
- Land.com: https://land.com
- Montana Land Source: https://mtlandsource.com

## Running Scrapers

### Locally (for development)

```bash
cd services/scrapers

# Montana Cadastral
SCRAPE_MODE=large MIN_ACRES=2 npm run cadastral

# Water Rights
npm run water-rights

# Listings
npm run listings
```

### In AWS (production)

Scrapers run on ECS Fargate, orchestrated by Step Functions. Trigger via:

```bash
aws stepfunctions start-execution \
  --state-machine-arn arn:aws:states:us-west-2:<account>:stateMachine:landfinder-scraping-workflow
```

## API Endpoints

### Authentication
- `POST /auth/login` - Sign in
- `POST /auth/register` - Create account

### Search
- `POST /search` - Submit search criteria
- `GET /search/{jobId}` - Get search status
- `GET /search/{jobId}/results` - Get results

### Parcels
- `GET /parcels/{id}` - Parcel details
- `GET /parcels/{id}/water-rights` - Water rights
- `GET /parcels/{id}/listings` - Listings
- `GET /parcels/{id}/insights` - AI insights

### User
- `GET /user/saved` - Saved parcels
- `POST /user/saved/{parcelId}` - Save parcel
- `DELETE /user/saved/{parcelId}` - Remove saved
- `GET /user/searches` - Search history

## Environment Variables

### Mobile App
| Variable | Description |
|----------|-------------|
| `EXPO_PUBLIC_API_URL` | API Gateway endpoint |

### Lambda Functions
| Variable | Description |
|----------|-------------|
| `DATABASE_SECRET_ARN` | RDS credentials secret |
| `USER_POOL_ID` | Cognito User Pool ID |
| `USER_POOL_CLIENT_ID` | Cognito Client ID |
| `USERS_TABLE` | DynamoDB users table |

### Scrapers
| Variable | Description |
|----------|-------------|
| `DATABASE_SECRET_ARN` | RDS credentials secret |
| `S3_BUCKET` | Scraping results bucket |
| `SCRAPE_MODE` | all, large, or county |
| `MIN_ACRES` | Minimum acreage filter |

## Estimated Costs (Monthly)

| Service | Cost |
|---------|------|
| RDS PostgreSQL (t3.micro) | $15-25 |
| DynamoDB (on-demand) | $10-30 |
| ECS Fargate (scraping) | $50-100 |
| Lambda | $5-20 |
| S3 | $5-10 |
| Bedrock (Claude) | $50-150 |
| API Gateway | $5-15 |
| **Total** | **$140-350** |

## Phase 2 Roadmap

- [ ] Social login (Google, Apple)
- [ ] Push notifications for new listings
- [ ] OpenSearch for advanced queries
- [ ] Additional state support
- [ ] Property comparison tool
- [ ] Due diligence checklist
- [ ] Agent/broker integration

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

Private - All rights reserved
