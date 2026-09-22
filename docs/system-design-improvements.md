# System Design Improvements — Interview Research & Recommendations

## Background

This document summarizes research into 2026 senior software engineer system design interview expectations and maps concrete improvements to this codebase. The goal is to ensure the project demonstrates the engineering judgment and operational maturity that interviewers explicitly grade at the senior level.

---

## What 2026 Senior System Design Interviews Evaluate

Research drawn from interviewing.io, Hello Interview, Design Gurus, Exponent, Pragmatic Engineer, Medium, and GeeksForGeeks:

### The six rubric dimensions

| Dimension | What interviewers look for |
|---|---|
| **Requirements clarification** | Spend the first 5 minutes defining functional requirements, non-functional requirements, and explicit out-of-scope before drawing anything |
| **High-level design first** | Sketch client → API → business logic → data → external deps before drilling into any single component |
| **Trade-off reasoning** | Every decision needs a "because" and a "but" — choosing eventual consistency, naming the latency tradeoff; adding a cache, naming the invalidation complexity |
| **Failure modes and operational maturity** | Explicitly a senior-bar requirement in 2026. Finishing a design without discussing observability, on-call debugging, or graceful degradation reads as "never been on call" |
| **Cost reasoning** | Newly graded in 2026: estimate costs, justify storage tier choices, explain what breaks at 10x scale |
| **AI-era infrastructure literacy** | Standard at any company shipping AI features: LLM serving, RAG pipelines, model versioning, graceful degradation when a model is unavailable |

### The most common senior-engineer failure modes

- Jumping to components before clarifying scope
- Describing what a component does rather than why it was chosen over alternatives
- Finishing the design without addressing observability — now an explicit rubric gap
- Over-engineering from day one ("I'd put Kafka in front of everything") without establishing the need
- Treating the session as a monologue rather than a conversation

### Key patterns Hello Interview identifies as interview separators

1. Dealing with contention (race conditions, double-booking, concurrent writes)
2. Multi-step processes / sagas (coordination across services with partial-failure handling)
3. Real-time updates (polling vs. webhooks vs. SSE trade-offs)
4. Scaling writes (bursty high-throughput, write-ahead logs, async processing)
5. Large blob handling (presigned URLs, CDN offloading)
6. Geospatial search (R-tree/GIST indexes, geohash partitioning, when to use PostGIS vs. Elasticsearch)
7. Caching and invalidation (the hard part is expiry, not addition)

---

## What Last Best Land Already Demonstrates Well

These are genuine strengths — articulate them explicitly in interviews.

| Strength | What it signals |
|---|---|
| CDK infrastructure as code | Infrastructure thinking, not just application code |
| PostGIS with GIST indexes on `coordinates` and `boundary` | Demonstrates geospatial pattern #6 above; can articulate why GIST over B-tree |
| TTL-differentiated caching by data domain (soil: 1yr, water rights: 1wk, listings: 24hr) | You reason about freshness by domain semantics, not a blanket TTL |
| AI integration at two layers (listing-to-parcel matching + buildability summaries) | Directly demonstrates AI-era infrastructure literacy |
| Multi-source data aggregation with schema normalization | Real engineering trade-off with real consequences (deduplication, source attribution) |
| Async job pattern with DynamoDB status tracking | Shows awareness of async patterns in Lambda context |
| Monorepo with clean service boundaries | Structural clarity that scales to a team |

---

## Recommended Improvements

### 1. Observability — structured logging, metrics, and tracing ✅ DONE

**Status:** Implemented

**What was added:**
- `services/api/shared/logger.ts` — AWS Lambda Powertools Logger; emits structured JSON to CloudWatch with `requestId`, `functionName`, and service name on every line
- `services/api/shared/metrics.ts` — Powertools Metrics using Embedded Metric Format (EMF); custom metrics written to stdout, CloudWatch ingests them without extra API calls or latency
- `services/api/shared/tracer.ts` — Powertools Tracer wrapping AWS X-Ray; patches AWS SDK clients to auto-instrument every service call
- `services/api/shared/db.ts` — X-Ray subsegments around every PostgreSQL query via `withDbSubsegment`
- `services/api/shared/bedrock.ts` — Bedrock client patched with `tracer.captureAWSv3Client`
- `services/api/search/handler.ts` — `logger.addContext(context)` for request correlation; emits `SearchExecuted`, `SearchLatency`, `SearchResultCount`, `SearchFailed` metrics; `metrics.publishStoredMetrics()` in finally block
- `services/api/parcel/handler.ts` — same pattern; emits `ParcelDetailFetched`, `InsightCacheHit`, `InsightGenerated`, `BedrockCallLatency`
- `infrastructure/lib/api-stack.ts` — `tracing: lambda.Tracing.ACTIVE` on all Lambdas; `tracingEnabled: true` on API Gateway; five CloudWatch alarms (API 5xx rate, search errors, parcel errors, search p99 latency, Bedrock p99 latency) wired to an SNS topic

**Why EMF over direct CloudWatch PutMetricData calls:** EMF writes structured JSON to stdout synchronously; Lambda flushes stdout at end of invocation. No extra network call, no added latency to the response path. CloudWatch Logs agent picks up the EMF JSON and creates the metrics asynchronously.

**What an on-call engineer can now do:**
- Filter CloudWatch Logs by `requestId` to trace a specific failing request end-to-end
- Query `SearchLatency` p99 in CloudWatch Metrics to identify slow searches before users complain
- Follow an X-Ray trace from API Gateway → Lambda → RDS → Bedrock to find where time is being spent
- Get paged via SNS when any alarm threshold is crossed

---

### 2. True async search with SQS + worker Lambda

**Status:** Not yet implemented

**The problem:** `search/handler.ts` creates a DynamoDB job with `status: 'processing'` then executes the PostgreSQL query synchronously in the same Lambda invocation. The first poll for status will almost always return `'completed'`. The async contract is illusory and the pattern won't scale — a slow geospatial query will hit API Gateway's 29-second timeout.

**What to build:**
- `POST /search` writes the job to DynamoDB and publishes a message to SQS; returns `{ searchId, status: 'processing' }` immediately (< 100ms)
- A worker Lambda triggered by SQS runs the actual query; can fan out sub-queries per county in parallel
- Dead-letter queue on the SQS queue catches jobs that exhaust retries; alarm fires on DLQ depth

**Trade-offs to be able to articulate:**
- Why SQS over SNS: SQS guarantees at-least-once delivery and allows the consumer to control processing rate; SNS is fan-out, not queue
- Why not Step Functions: Step Functions makes sense when there are multiple sequential or branching steps with state; a single search job is a single async operation — Step Functions adds cost and complexity without benefit here
- Visibility timeout must exceed worker Lambda timeout (60s) to avoid duplicate processing

---

### 3. Geographic bounding box and polygon search

**Status:** Not yet implemented

**The problem:** The PRD specifies "draw a bounding box or polygon on the map" as a core feature. The `parcels` table has GIST indexes on `coordinates` and `boundary`. But `executeSearch` in the search handler only filters by string equality on `state` and `county` — the spatial query is never built.

**What to add to `executeSearch`:**

```sql
-- Bounding box (from map drag)
WHERE ST_Within(
  p.coordinates::geometry,
  ST_MakeEnvelope($minLng, $minLat, $maxLng, $maxLat, 4326)
)

-- Polygon (from drawn shape)
WHERE ST_Within(
  p.coordinates::geometry,
  ST_GeomFromGeoJSON($polygon)
)
```

**Trade-offs to be able to articulate:**
- Why GIST over B-tree for spatial: B-tree excels at single-dimension range queries; spatial queries require multi-dimensional range search across lat/lng simultaneously — GIST's R-tree structure is built for this
- `ST_Within` vs `ST_DWithin`: `ST_Within` checks containment; `ST_DWithin` checks proximity within a radius — use `ST_Within` for polygon/bbox searches and `ST_DWithin` for "parcels near a point"
- At millions of rows, consider partitioning by state/county before the spatial index scan to reduce the index seek space

---

### 4. Event-driven enrichment pipeline

**Status:** Not yet implemented

**The problem:** The PRD says "heavy GIS intersections run at indexing time." The implementation generates insights on the first `GET /parcels/{id}/insights` call — the first user to open a parcel detail view waits for a synchronous Bedrock call (up to several seconds). This is a latency and reliability problem.

**What to build:**
- When `saveListing` in the scraper inserts or updates a listing, publish a `listing.indexed` event to EventBridge or SNS
- An enrichment Lambda subscribes; fetches GIS data from external APIs; calls Bedrock for the summary; writes to `parcel_insights`
- The parcel handler reads the pre-computed insight instead of generating on-demand
- If enrichment hasn't run yet (new parcel), the handler returns partial data with a `enrichmentPending: true` flag — the frontend polls or shows a loading state

**Trade-offs to be able to articulate:**
- Decouples scraper throughput from enrichment latency — the scraper can index 1000 listings without waiting for 1000 Bedrock calls
- Introduces eventual consistency: a newly indexed listing may not have an insight for 30–60 seconds
- EventBridge vs SNS: EventBridge adds content-based filtering (only trigger enrichment for `listing.indexed` events, not `listing.priceUpdated`); SNS is simpler but fans out all events to all subscribers

---

### 5. Store search results in S3 instead of DynamoDB

**Status:** Not yet implemented

**The problem:** `results: results.slice(0, 100)` in the search handler stores up to 100 search results in a single DynamoDB item. DynamoDB has a hard 400KB per-item limit. Each result includes parcel data, listing data, images array, and a preview insight — this can silently exceed the limit and throw a `ValidationException`.

**What to change:**
- Write results to `s3://landfinder-search-results/{searchId}.json`
- Store only `{ s3Key, status, resultCount, createdAt, completedAt }` in DynamoDB
- Results endpoint fetches from S3 and streams paginated slices

**Trade-offs:**
- S3 reads add ~20ms latency vs DynamoDB's ~1ms; acceptable for a results page that users will wait for anyway
- S3 has no per-object size limit; DynamoDB's 400KB cap is a hard constraint
- S3 `GetObject` costs $0.0004 per 1000 requests vs DynamoDB read capacity pricing — cheaper at scale

---

### 6. RDS Proxy

**Status:** Not yet implemented

**The problem:** Lambda scales from 0 to hundreds of concurrent executions in seconds. RDS has a fixed connection limit (typically 100–1000 depending on instance size). Each Lambda cold start creates a new `pg.Pool` with up to 5 connections. Under moderate load, this exhausts RDS connections and causes cascading 503s across all functions.

**What to add in `database-stack.ts`:**

```typescript
const rdsProxy = new rds.DatabaseProxy(this, 'RdsProxy', {
  proxyTarget: rds.ProxyTarget.fromInstance(this.database),
  secrets: [this.database.secret!],
  vpc,
  dbProxyName: 'landfinder-proxy',
  requireTLS: true,
});
```

**Why this matters in an interview:** Interviewers who know Lambda will probe connection management. Naming RDS Proxy and explaining the Lambda cold-start connection exhaustion pattern is a concrete signal that you've operated Lambda at scale, not just deployed it.

---

### 7. Input validation with Zod

**Status:** Not yet implemented

**The problem:** `JSON.parse(event.body) as SearchCriteria` in the search handler has no validation. Malformed input propagates into the dynamic SQL query builder, causing unhandled exceptions that surface as 500s instead of 400s.

**What to add:**

```typescript
import { z } from 'zod';

const SearchCriteriaSchema = z.object({
  state: z.string().length(2),
  county: z.string().optional(),
  minAcreage: z.number().positive().optional(),
  maxAcreage: z.number().positive().optional(),
  minPrice: z.number().positive().optional(),
  maxPrice: z.number().positive().optional(),
  waterRightsRequired: z.boolean().optional(),
  boundingBox: z.object({
    minLng: z.number(), minLat: z.number(),
    maxLng: z.number(), maxLat: z.number(),
  }).optional(),
});
```

**The principle:** Validate at system boundaries (user input, external APIs); trust internal code. This is a testable principle to articulate in interviews.

---

### 8. Unit tests for scraper parsers and query builder

**Status:** Not yet implemented

**The problem:** `parsePrice`, `parseAcreage`, and `extractCounty` in `services/scrapers/listings/index.ts` are pure functions that parse strings from external website HTML. When LandWatch or Land.com updates their markup (they do, regularly), these silently return `null` and listings stop matching parcels. The SQL query builder in `executeSearch` is also untested.

**Why tests here specifically:** These functions sit at the boundary between a fragile external system (website markup) and the database. Testing them signals that you know where the risk surface is — not just that you can write tests, but that you know *what* to test.

---

## Implementation Order

| # | Change | Effort | Interview signal |
|---|---|---|---|
| 1 | Observability (logger, metrics, X-Ray, alarms) | Medium | ✅ Done — explicit 2026 rubric item |
| 2 | True async search with SQS + worker Lambda | High | Distributed systems pattern with full trade-off discussion |
| 3 | Geographic bounding box search | Low-Medium | Closes design-to-implementation gap; geospatial is a top-7 pattern |
| 4 | Event-driven enrichment pipeline | High | Decoupling + saga pattern; failure isolation discussion |
| 5 | S3 for search result storage | Low | Concrete scalability fix for a real DynamoDB constraint |
| 6 | RDS Proxy | Low | Shows Lambda/DB failure mode awareness |
| 7 | Zod input validation | Low | "Validate at system boundaries" principle |
| 8 | Unit tests for parsers + query builder | Medium | Shows you know where the risk surface is |
