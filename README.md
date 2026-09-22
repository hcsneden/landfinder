# Last Best Land

Due diligence for rural Montana land. Look up a parcel by address or parcel
number and see its water rights, road access, utilities, flood and wildfire
risk, conservation easements, soils, nearby wells, and an AI-written
buildability summary, all from public state and federal data sources.

## Architecture

| Layer | Technology |
| --- | --- |
| Web app | React, Vite, MapLibre GL, TanStack Query, Zustand |
| API | AWS Lambda (Node 20, ARM) behind API Gateway with a Cognito authorizer |
| Database | Aurora Serverless v2 PostgreSQL with PostGIS, accessed through the RDS Data API |
| Async search | SQS queue and a worker Lambda, job state in DynamoDB |
| Scrapers | ECS Fargate tasks orchestrated by Step Functions |
| AI | Amazon Bedrock (Claude Haiku 4.5) for summaries and for-sale classification |
| Infrastructure | AWS CDK (TypeScript) |

The Lambdas run outside the VPC and reach Aurora through the Data API, so there
is no NAT gateway. The cluster scales to zero when idle. A scheduled ping and a
`GET /warmup` call from the web app keep the resume off the user's first query.

Each external data source is fetched on demand for a parcel and cached in
`parcel_enrichment_cache` with a per-source TTL. See
`services/api/parcel/sources/` for one module per source.

`services/parcel-go` is a Go port of the parcel lookup, kept as a reference
implementation with its own tests.

## Repository layout

```
apps/web/              React web app
apps/mobile/           Expo app (lookup, search, saved parcels)
packages/shared/       Types and pure helpers shared by every workspace
services/api/          Lambda handlers
services/scrapers/     Fargate scraper tasks
services/parcel-go/    Go port of the parcel lookup
infrastructure/        CDK stacks
database/              SQL migrations, applied by the migration Lambda
docs/                  Design notes and runbooks
```

## Development

Requires Node 20 and, for the Go service, Go 1.25.

```bash
npm install
npm run typecheck      # every TypeScript workspace
npm run lint
npm test               # vitest unit tests
npm run test:go
npm run web            # Vite dev server on http://localhost:3001
```

The web app reads `VITE_API_URL` from `apps/web/.env.local`. The optional
`VITE_DEMO_EMAIL` and `VITE_DEMO_PASSWORD` variables enable a demo sign-in
button. Treat that account as public: its credentials are in the client bundle.

## Deployment

`./deploy.sh` reads AWS credentials from `.env`, builds the web app, and runs
`cdk deploy`. See `docs/deployment.md` for the first-time steps, including the
Serper secret, the migration Lambda, and the scraper images.

## API

All routes except `/auth/*` require a Cognito ID token as a Bearer token.

| Method and path | Purpose |
| --- | --- |
| `POST /auth/login`, `/auth/register`, `/auth/refresh` | Session tokens |
| `GET /parcels/lookup?q=` | Resolve an address or parcel number. Returns a parcel or a candidate list. |
| `GET /parcels/{id}` | Parcel record |
| `GET /parcels/{id}/water-rights` | DNRC water rights |
| `GET /parcels/{id}/road-access` | TIGER, BLM, and USFS roads near the parcel |
| `GET /parcels/{id}/utilities` | HIFLD transmission lines and service territory |
| `GET /parcels/{id}/environmental-risk` | FEMA flood zones, wildfire rating, USGS mine sites |
| `GET /parcels/{id}/conservation-easements` | NCED easements |
| `GET /parcels/{id}/soil` | NRCS SSURGO map units |
| `GET /parcels/{id}/groundwater?radius=` | MBMG GWIC well logs within the radius in miles |
| `GET /parcels/{id}/hunting-districts` | FWP districts overlapping the parcel |
| `GET /parcels/{id}/stream-gauges` | USGS gauges within 50 miles with daily flows |
| `GET /parcels/{id}/insights` | Buildability summary |
| `GET /parcels/{id}/listing-status?refresh=` | Web search for an active listing |
| `POST /search`, `GET /search/{jobId}`, `GET /search/{jobId}/results` | Async parcel search |
| `GET /user/saved`, `POST` and `DELETE /user/saved/{parcelId}` | Saved parcels |
| `GET /user/searches` | Search history |
| `GET /warmup` | Wakes the database |

Enrichment routes accept `?refresh=true` to bypass the cache.

## Data sources

| Data | Source |
| --- | --- |
| Parcels | Montana State Library cadastral (MSDI) |
| Address points | Montana Structures and Addresses (E911) |
| Water rights | DNRC Water Right Query System |
| Roads | Census TIGERweb, BLM National Transportation Routes, USFS Road Core |
| Electric | HIFLD transmission lines and retail service territories |
| Flood | FEMA National Flood Hazard Layer |
| Wildfire | FEMA National Risk Index |
| Mines | USGS Mineral Resources Data System |
| Easements | National Conservation Easement Database |
| Soils | USDA NRCS Soil Data Access |
| Wells | DNRC Source Aquifer Explorer (MBMG GWIC) |
| Hunting districts | Montana FWP |
| Stream gauges | USGS NWIS |
| Geocoding | US Census Geocoder, with Nominatim as a fallback |
| Listing search | Serper.dev |

These are public, unauthenticated services and they move. Three have moved
during this project. Each URL lives at the top of its source module.
