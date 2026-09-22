# System design notes

What the system demonstrates, the trade-offs behind each choice, and what is
still open. Written for interview preparation.

## Choices and their trade-offs

| Choice | Why | Cost or alternative |
| --- | --- | --- |
| Aurora Serverless v2 at 0 ACU minimum, accessed through the RDS Data API | Near-zero idle cost, PostGIS, and no VPC networking for Lambdas, which removed the NAT gateway | About 20 seconds to resume from pause. The Data API has a 1 MB response limit, one round trip per statement, and no array parameters (arrays travel as text literals). An RDS Proxy with VPC Lambdas is the alternative when traffic is steady. |
| Domain-per-function Lambdas with an internal route table | Fewer cold starts than one function per route, less shared-code duplication than one monolith | A bug in one route can affect its siblings' cold-start time |
| SQS plus a worker Lambda for search | Search resolves for-sale status with web search and a model call, which does not fit API Gateway's 29 second limit | Clients poll for results. Results live inline on the DynamoDB job item, which caps at 400 KB. Moving results to S3 is the next step at scale. |
| Per-source enrichment cache with per-source TTLs | GIS data changes on different clocks: roads yearly, soils rarely, listings weekly. A stale entry is served when the source is down. | Cache invalidation is time based only. A `refresh=true` query parameter forces a fetch. |
| Cognito behind auth Lambdas that use the admin flow | One API surface, no Cognito SDK in either client | Passwords transit the Lambda. Registration skips email verification, which is a demo shortcut. |
| ECS Fargate for scrapers, Step Functions for ordering | Runs exceed Lambda's 15 minute limit. Water rights depend on the cadastral load, so they run in sequence. | Tasks use public subnets with a public IP instead of a NAT gateway, which saves about $32 a month. |
| Bedrock with Claude Haiku | Cheapest model that writes a usable summary and classifies search snippets | The classification has no evaluation set yet |
| Serper.dev for web search | Cheap Google results | It scrapes Google. Brave Search API and Tavily are the alternatives if that matters. |
| MapLibre with CARTO tiles | No API key, no per-load billing | Verify the CARTO basemap terms before a public launch |

## Failure modes handled

- Every external source call has a timeout and is wrapped in `allSettled`
  with its siblings, so one slow source does not fail the endpoint.
- An all-sources-failed fetch returns the stale cache entry when one exists.
- The search worker reports partial batch failures so SQS retries only the
  failed message, and a DLQ alarm fires after three failures.
- Aurora resume exceptions are retried inside the Data API client.
- CloudWatch alarms cover API 5xx, Lambda errors, search latency, and Bedrock
  latency, all routed to an SNS topic.

## Open items

1. **Search results in S3.** Store `{ s3Key, status, resultCount }` on the job
   item and stream pages from S3. Removes the 400 KB ceiling.
2. **Input validation with a schema library.** Search criteria and the
   groundwater radius are validated by hand. A zod schema per boundary would
   turn malformed input into a 400 consistently.
3. **Per-user rate limiting.** Each lookup or search can trigger web search and
   model calls. The demo account is public, so a per-user budget or an API
   Gateway usage plan belongs before wider sharing.
4. **Data source smoke test.** A scheduled Lambda that runs one known query per
   upstream service and alarms when one moves. Three sources have moved
   already.
5. **USGS NWIS migration.** `waterservices.usgs.gov` is scheduled for
   retirement. The replacement is `api.waterdata.usgs.gov`.
6. **Listing classification evaluation.** Label 50 results and report
   precision before trusting the for-sale badge.
7. **Mobile parity.** The Expo app covers lookup, search, saved parcels, water
   rights, and the summary, but not the other enrichment sources.
