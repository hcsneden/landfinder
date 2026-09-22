# Code review

Review date: 2026-09-22. Branch: `aurora-data-api` with uncommitted changes included.
Scope: every tracked source, config, SQL, and doc file in the repository.

Status: the fixes in this review were applied on the same day. The items that
remain open are listed under "Open items" in `system-design-improvements.md`:
search results in S3, schema validation, per-user rate limiting, the data
source smoke test, the USGS migration, and the listing classification
evaluation. The review below is kept as the record of what was found.

Verified during the review:

| Check | Result |
| --- | --- |
| `npm run typecheck` (shared, api, scrapers, web, infrastructure) | Passes |
| `npm run lint` | Fails. No ESLint config exists anywhere in the repo. |
| TypeScript tests | None exist |
| `go vet ./...` and `go test ./...` in `services/parcel-go` | Pass |
| Mobile app | Not installed (`apps/mobile/node_modules` holds two entries) and excluded from `npm run typecheck` |

## Summary

The backend has a clear shape: Lambda handlers per domain, Aurora Serverless v2 through the RDS Data API, a cache-then-fetch pattern for each external GIS source, and an SQS worker for the slow search path. The infrastructure is real CDK with alarms, a DLQ, and cost reasoning that you can defend. The web app is coherent and the Go port is clean.

The gaps that would come up in a senior interview fall into four groups:

1. **Security and correctness bugs** that are cheap to fix and expensive to be asked about: TLS verification disabled, an authorization check missing on search jobs, duplicate rows from a join, and a numeric type that lies to every client.
2. **One pattern written seven times.** The per-parcel cache logic, the buffered-geometry SQL, the row-to-type mappers, and the ArcGIS fetch boilerplate are each duplicated across files. The 1,480-line `parcel/handler.ts` exists because the abstraction was never extracted.
3. **Dead surface area from removed features.** The listing feed is gone but its table, types, endpoint, UI cards, and search filters remain. The mobile app targets an API that no longer matches it.
4. **No safety net.** No lint config, no TypeScript tests, no CI. The docs describe an earlier architecture.

None of these are hard. Most are one afternoon each. The rest of this document lists them with file and line references, then evaluates every external vendor and data source.

## Priority 1: security and correctness

### TLS verification is disabled in three places

- `services/api/parcel/lookup.ts:30` creates an `https.Agent` with `rejectUnauthorized: false` and uses it for every host the lookup touches, including `geocoding.geo.census.gov`.
- `infrastructure/lib/api-stack.ts:198` sets `NODE_TLS_REJECT_UNAUTHORIZED: '0'` on the lookup Lambda. That variable is process wide. It also disables verification for the AWS SDK, Secrets Manager, Serper, and Nominatim calls made from that function.
- `services/scrapers/shared/db.ts:57` and `services/parcel-go/internal/arcgis/client.go:33` do the same for Postgres and for the Go GIS client.

The stated reason is that Montana state GIS hosts serve a chain with an intermediate CA missing from the Node bundle. The fix is to ship the missing intermediate as a PEM file and point `NODE_EXTRA_CA_CERTS` at it in the Lambda bundle, and to use the RDS CA bundle for the scrapers' `pg` connection. Then remove all four bypasses. If an interviewer sees `rejectUnauthorized: false` they will ask about it, and "the state's cert chain is broken" is only a good answer if you follow it with "so I pinned the intermediate."

### Any user can read any other user's search job

`services/api/search/handler.ts:89` (`getSearchStatus`) and `:120` (`getSearchResults`) look up the job by `jobId` and return it without comparing `Item.userId` to the caller's sub. Job IDs are UUIDv4 so they are not guessable, but the check is one line and its absence is a classic IDOR finding. Add `if (result.Item.userId !== userId) return notFound()`.

### Water rights filter multiplies result rows

`services/api/search/worker.ts:68` switches to `INNER JOIN water_rights wr` when `waterRightsRequired` is set, and the query groups by `wr.id` (line 110). A parcel with three water rights comes back three times. Replace the join with `EXISTS (SELECT 1 FROM water_rights WHERE parcel_id = p.id)` in the `WHERE` clause and drop the `GROUP BY` entirely, since nothing is aggregated.

### Price filters query a table nothing writes to

`services/api/search/worker.ts:47` and `:53` filter on `l.price` from the `listings` table. The listings scraper was removed (staged deletion of `services/scrapers/listings/`), so `listings` is empty and any search with `minPrice` or `maxPrice` returns zero rows. The price that the app actually knows comes from `listing_status_cache.price`. Either filter on that, or remove the price criteria from `SearchCriteria` and the mobile search form.

### DECIMAL columns reach clients as strings

`services/api/shared/db.ts:85` decodes `int8` and `numeric` as strings, which matches what `node-postgres` did. Every `DECIMAL` column in the schema (`acreage`, `building_value`, `price`, `flow_rate`, `volume`, `mean_flow_cfs`) therefore arrives in JavaScript as `"12.50"`, while every row interface declares `number` (for example `services/api/parcel/handler.ts:19`). The stream gauge code knows this and calls `Number()` (`handler.ts:411`). Nothing else does. Consequences you can observe: `Parcel.acreage` is a string in the API JSON, `formatAcreage` does `acreage < 1` on a string, the web candidate filter does arithmetic on strings, and `parcel.buildingValue.toLocaleString()` in `ParcelDetailSheet.tsx:252` formats without thousands separators.

Pick one policy. The simplest is to decode `numeric` as `Number` in `decodeScalar` (the schema's precision never exceeds 2 decimal places, so double precision is safe) and leave `int8` as string. Then the row interfaces become true.

### The mobile app sends the wrong token

`apps/mobile/services/api.ts:37` sends `tokens.accessToken`. `apps/web/src/services/api.ts:36` sends `idToken`. The API Gateway Cognito authorizer in `infrastructure/lib/api-stack.ts:309` is created without `authorizationScopes`, and per the API Gateway docs an authorizer with no scopes validates ID tokens, not access tokens. One of the two clients is wrong, and the mobile one is the likely candidate. I have not run the mobile app to confirm.

### Scrapers run in the wrong order

`infrastructure/lib/scraping-stack.ts:246` runs all four scrapers in a Step Functions `Parallel` state. The water rights scraper selects parcels that have no water rights yet (`services/scrapers/water-rights/index.ts:203`), so it depends on the cadastral scraper having finished. Run cadastral first, then water rights, with hunting districts and stream gauges in parallel alongside.

### Sessions expire after one hour with no refresh

Cognito tokens are valid for one hour (`auth-stack.ts:49`). Neither client refreshes them. The web app redirects to `/auth` on the first 401 (`apps/web/src/services/api.ts:55`) and the mobile app has a `TODO` (`apps/mobile/services/api.ts:50`). The refresh token is stored but never used. Add a `POST /auth/refresh` that calls `InitiateAuth` with `REFRESH_TOKEN_AUTH`, or move token handling to the Cognito client SDK. The web app also keeps tokens in `localStorage`, which is standard for SPAs but worth being able to discuss (XSS exposure versus HttpOnly cookies).

### Registration skips email verification

`services/api/auth/register.ts:82` sets `email_verified: 'true'` on `AdminCreateUser` and suppresses the welcome message. Anyone can register any email address. This is a deliberate shortcut for a demo, and it is fine as long as you can say so and name the alternative (`SignUp` plus `ConfirmSignUp`, or a verification link).

### Unbounded input reaches an external query

`services/api/parcel/handler.ts:1463` passes a caller-supplied `radius` to the GWIC envelope query with no upper bound. Clamp it (for example to 10 miles).

### Cost exposure through the public demo account

The README documents a shared demo account with normal write access. Each lookup of an ambiguous address can trigger up to 10 Serper plus Bedrock calls (`lookup.ts:592`), each search job up to 15 (`listingStatus.ts:87`), and each `refresh=true` a fresh pair. The only throttle is the global API Gateway rate limit. Add a per-user budget or an API Gateway usage plan before sharing the demo link widely.

## Priority 2: redundancy and architecture

### The per-parcel cache pattern is written seven times

Road access, utilities, environmental risk, conservation easements, listing status, soil, and groundwater each do the same thing: read a one-row-per-parcel cache table, compare `fetched_at` to a TTL, honor `refresh=true`, call an external source, upsert, and return. The code is in `parcel/handler.ts` (four copies), `shared/soil.ts`, `shared/groundwater.ts`, and `shared/listingStatus.ts`, with small drifts between copies:

- Conservation easements cache even when the fetch failed (`handler.ts:1387`). The others skip the write when every source failed.
- Groundwater and soil return the JS timestamp while writing `NOW()` to the database. Harmless but inconsistent.
- The TTL for listing status is defined twice, once in JavaScript (`listingStatus.ts:6`) and once as `INTERVAL '7 days'` in SQL (`listingStatus.ts:112`).

One helper removes all of it:

```ts
withParcelCache<T>(table, parcelId, ttlMs, forceRefresh, fetch: () => Promise<T>)
```

Or go one step further: one `parcel_enrichment_cache (parcel_id, source, payload jsonb, fetched_at)` table replaces seven identical tables. Then adding a data source is a fetch function and a TTL, not a migration.

### The buffered search geometry SQL is written three times

`handler.ts:636`, `:817`, and `:1058` each build the same `ST_Transform(ST_Buffer(ST_Transform(COALESCE(boundary, point), 32612), meters), 4326)` expression with different buffer sizes. Meanwhile `soil.ts:1037` buffers on `geography` instead, which needs no UTM zone at all. Montana spans UTM zones 11 through 13, so the hardcoded 32612 is an approximation you would have to explain. Buffer on geography everywhere and put it in one `parcelSearchGeometry(parcelId, meters)` function.

### Row to type mappers are duplicated

The `parcels` row to `Parcel` mapping appears in `parcel/handler.ts:101`, `parcel/lookup.ts:801`, `parcel/lookup.ts:877`, and `search/worker.ts:143`. `ParcelRow` (`handler.ts:12`) and `UpsertedParcel` (`lookup.ts:665`) are the same interface. `SavedRow` is declared twice in `user/handler.ts`. Put one `toParcel(row)` and one `ParcelRow` in `services/api/shared/parcels.ts`.

### Four near-identical listing status shapes

`ListingStatus` and `SearchListingStatus` in `packages/shared`, `ListingStatusResult` in `listingStatus.ts`, and `ListingStatusCheck` in `bedrock.ts` differ only by `parcelId`, `summary`, and `fetchedAt`. Derive them: `type ListingStatusCheck = Omit<ListingStatus, 'parcelId' | 'fetchedAt'>`.

### Response and Bedrock helpers repeat their boilerplate

`shared/response.ts` builds the same headers in three functions. `shared/bedrock.ts` builds the same `InvokeModelCommand` and parses the same envelope in two functions. Each collapses to one private function plus thin wrappers.

### Water rights parsing exists in three languages' worth of copies

`parseStatus`, `parsePriorityDate`, and the water type inference exist in `parcel/lookup.ts:200`, `scrapers/water-rights/index.ts:123`, and `parcel-go/internal/parcel/waterrights.go:191`. The vertex-average centroid is in `lookup.ts:68`, `scrapers/cadastral/index.ts:106`, and `geom.go:11`. The TypeScript copies belong in `packages/shared` so the scraper and the API cannot drift.

### The centroid is not a centroid

All three centroid implementations average the ring vertices, including the closing vertex, so every polygon is biased toward its first point. The Go test `geom_test.go:12` actually asserts the wrong answer: it expects roughly 0.4 for a unit square whose centroid is 0.5. Since the parcel is upserted into PostGIS anyway, compute `ST_Centroid(boundary)` or `ST_PointOnSurface(boundary)` in the upsert SQL and delete the JavaScript and Go versions.

### `parcel/handler.ts` should be a route table over modules

The file is 1,480 lines with a hand-rolled `path.endsWith` router at the bottom (`:1397`). Soil and groundwater already live in their own modules, so the pattern exists. Move road access, utilities, environmental risk, stream gauges, insights, and easements to `services/api/parcel/sources/*.ts`, share `fetchArcGis` and the geometry helper, and make the handler a `Record<string, (parcelId, query) => Promise<T>>`. Two small things to fix while you are there: non-GET returns 400 instead of 405 (`:1406`), and the `parcelId` guard is repeated 13 times.

### Two routers use two different keys

`search/handler.ts:172` matches on `event.resource` for two routes and `path.endsWith` for the third. `user/handler.ts:179` does the same. Use `resource` throughout. It is the API Gateway template string and cannot collide.

### Lookup strategy chain duplicates its success path

`lookup.ts:786` (single TBD candidate) repeats the upsert, seed, and map steps of the main path at `:859`. The Go port already shows the cleaner shape: resolve a `feature` through an ordered list of strategies, then one `persist(feature)`. Port that structure back.

### ArcGIS `where` clauses are built by string interpolation

`lookup.ts:125`, `:143`, `:458`, `:482`, `:621`, `:642` and `scrapers/water-rights/index.ts:70` interpolate user or database text into ArcGIS SQL with a hand-rolled `sanitizeLike`. The target is a read-only public service, so the blast radius is small, but you should be able to say that out loud and point to the escape function. Consider a single `arcgisWhere(field, op, value)` helper so the escaping has one home.

### Search results live inside a DynamoDB item

`worker.ts:278` stores up to 100 `SearchResult` objects in one item. DynamoDB's item limit is 400 KB. Your own `docs/system-design-improvements.md` item 5 describes the fix (S3). Either do it or cap the stored payload and say why.

### Three stores hold user data

Cognito holds identity. The `landfinder-users` DynamoDB table (`database-stack.ts:102`) duplicates `sub`, `email`, and `createdAt`, and `login.ts:83` already falls back to the token when the row is missing, so the table adds nothing. Search jobs are in DynamoDB and saved parcels are in Postgres. Dropping the users table, its unused `email-index` GSI, and the `USERS_TABLE` env var removes a whole store. Search jobs could move to Postgres too, but DynamoDB TTL is a fair reason to keep them.

### Insights depend on the UI having called other endpoints first

`getInsights` (`handler.ts:1144`) reads the road, utility, environmental, and easement cache tables directly. If the UI has not fetched those yet, the prompt says "not yet available" and the summary is cached for 7 days. The web app works around this by gating the insights query on the others (`ParcelDetailSheet.tsx:99`). Cleaner: have `getInsights` call the same source functions (which hit cache or fetch), so the API is correct regardless of client order.

### Cognito is used through admin APIs from a Lambda proxy

`login.ts` and `register.ts` call `AdminInitiateAuth`, `AdminCreateUser`, and `AdminSetUserPassword`. The user pool client also enables `userPassword` and `userSrp` flows and a hosted UI domain (`auth-stack.ts:43`, `:56`) that nothing uses. Also `isValidPassword` in `register.ts:35` duplicates the pool's password policy. This design is defensible (one API surface, no Cognito SDK on clients) but you should be able to name the alternative (clients talk to Cognito directly with SRP, Lambda never sees passwords) and remove the unused flows and domain.

### Environment validation is scattered

Every handler starts with `const X = process.env.X; if (!X) throw`. A single `shared/env.ts` that reads and validates once at cold start is shorter and gives one place to list what a Lambda needs.

### Scrapers

- `fetchWithTimeout` is copied four times. `calculateCentroid` twice. The S3 run-summary write four times. The `process.env.S3_BUCKET || 'landfinder-scraping'` fallback four times (and the fallback bucket name is wrong, the real bucket has the account and region suffix).
- `scrapeCounty` and `scrapeLargeParcels` in `cadastral/index.ts` are the same loop with a different `where`. `queryParcels` and `queryParcelsByAcreage` likewise.
- The cadastral scraper and the lookup use different cadastral services with different field names (`gis.dnrc.mt.gov/.../Cadastral_Parcels` with `COUNTYNAME`, `ACRES`, `GEOCODE` versus `gisservice.mt.gov/.../msdi_cadastral_map_v1` with `CountyName`, `TotalAcres`, `PARCELID`). The scraper writes `geo_id = GEOCODE` while the lookup writes `geo_id = PARCELID`. The water rights scraper then queries WRQS by `geo_id`. Confirm those are the same identifier in both feeds, and either way use one cadastral source.
- The four Dockerfiles are identical except for a folder. One Dockerfile with a build `ARG`. They also copy only `package.json` and run `npm install`, so builds are not reproducible. Copy `package-lock.json` and use `npm ci`. They run `ts-node --transpile-only` in production with a `TS_NODE_COMPILER_OPTIONS` override. Compile with `tsc` or `esbuild` in the build stage and run `node`.
- `water-rights/index.ts:295` exports symbols from a file that runs `main()` on import.

### Infrastructure

- `bin/app.ts:2` imports `source-map-support/register` but `infrastructure/package.json` does not declare it. It works only because a transitive dependency happens to install it.
- `UserPoolId` and `UserPoolClientId` are output twice (`app.ts:68` and `auth-stack.ts:63`).
- `infrastructure/tsconfig.json` is the CDK init template with a dozen flags that duplicate the root config. Extend the root and override `module` and `outDir`.
- `web-stack.ts` constructs `S3BucketOrigin.withOriginAccessControl(bucket)` twice. Build one origin and reuse it.
- `deploy.sh` reads raw access keys from `.env` and writes a named profile. It is fine for a solo project but be ready to say "SSO or an assumed role in a real team".

### Web app

- `services/api.ts:30` reads the token by parsing the zustand persist JSON out of `localStorage` instead of calling `useStore.getState().tokens`. That duplicates knowledge of the storage key and the persisted shape.
- `PUBLIC_ROAD_TYPES` (`ParcelDetailSheet.tsx:896`) restates the public-access rule from `handler.ts:627` (which itself appears three times). Put `isPublicRoad(type)` in `packages/shared`.
- The `Preferences` "clear" literal is repeated in `SearchPanel.tsx:276`. Export a `DEFAULT_PREFERENCES` from the store and reuse it there and in the store initializer.
- The `hasAnyPreferenceSet` expression appears in `MapView.tsx:163` and `ParcelDetailSheet.tsx:438`.
- `ParcelDetailSheet.tsx:136` has an `eslint-disable-next-line` comment but there is no ESLint config, so it does nothing.
- `index.css` is 2,037 lines with roughly 30 overrides of `.dl-button` and `!important` on `Badge` colors. That signals the design library is not themeable enough for this app. Either add the variants to `@hcsneden/design-library` or stop using it for those components. Seven defined classes are unused (`listing-source`, `wr-status-active`, `wr-status-inactive`, `wr-status-pending`, and three MapLibre selectors).
- `WILDFIRE_RISK_CLASS` (`ParcelDetailSheet.tsx:1132`) reuses `broadband-fiber` and `wr-status-unknown` classes for wildfire badges. Name the classes for what they mean.

### Mobile app

The mobile app is behind the API in ways that make it worse than absent for an interview:

- It calls `POST /auth/refresh` and `POST /auth/logout`, which do not exist (`services/api.ts:80`, `:85`).
- `lookupParcel` is typed as returning `Parcel`, but the API returns `Parcel | ParcelCandidates`. A candidate response pushes `/parcel/undefined` (`(tabs)/search.tsx:215`).
- It exposes none of the road, utility, environmental, soil, or groundwater data.
- `profile.tsx` has five menu items that do nothing. `[id].tsx:28` declares `screenWidth` and never uses it. The tab bar uses emoji as icons.
- `expo ~55` with `expo-router ~4.0` is a version pairing I could not confirm as valid, and dependencies are not installed locally.

Either bring it to parity with a shared API client package (`packages/api-client`, fetch based, token provider injected) or move it to a branch and remove it from the README. A half-working client invites the question "why is this here?"

### Go service

The port is well structured (interfaces, `httptest`, a build-tagged integration test) and I would keep it as a showcase. Three notes:

- `cmd/parcel/main.go:50` names a helper `cmp`, which shadows the standard library package of the same name since Go 1.21. Rename it `envOr`.
- `arcgis/client.go:51` and `lookup.ts:432` hardcode a personal email in the User-Agent. Read it from an environment variable.
- It is a second implementation of the lookup cascade with no test asserting the two agree. Decide whether it is the future service or a demo, and say so in its README. Right now the README says "ported to demonstrate", which is honest and fine.

## Priority 3: dead code and drift

- **Listings feed remnants.** The scraper is deleted (good). Still present: the `listings` table and four indexes, `Listing` and `ListingSource` types, `getListingSourceLabel`, `GET /parcels/{id}/listings`, `getListings` in the handler, `ListingCard` in both clients, the `listing` field on `SearchResult`, the price criteria, and the README's listing section. Remove them or keep only the table with a comment that says a licensed feed would populate it.
- **Broadband.** `BROADBAND_DATA_AVAILABLE` is a constant `false` (`handler.ts:721`). The `broadband` column, the `BroadbandProvider` type, the Bedrock prompt section, the `broadband` preference, and `BroadbandProviderRow` all exist to render "no data". `ElectricAccess.nearestLineDistanceMiles` is always `null`.
- **Schema.** `search_vector`, its trigger, and its GIN index are never queried. `parcel_search_view` in `001_initial_schema.sql:136` is never used and is absent from the migration Lambda. `idx_saved_user` duplicates the primary key prefix. The `email-index` GSI on the users table is unused.
- **Two schema sources of truth.** `services/api/migration/handler.ts` embeds the full schema as a string and `database/*.sql` has a partial, older copy. Migration 007 is listed after 009. Keep the SQL files as the source, number them, and have the Lambda load them (esbuild's `text` loader handles `.sql` imports), or adopt a migration tool.
- **Unused symbols.** `UTILITY_FETCH_TIMEOUT_MS` (`handler.ts:724`), `InsightType`, `PropertyType`, `MontanaCounty`, `generateSearchId`, `truncateText`, `SearchJobMessage.createdAt`, the `LambdaSecurityGroup` (documented as "kept for one deploy").
- **Stale docs.** `README.md` says RDS PostgreSQL, describes a mobile-first stack, documents `npm run listings`, lists the old cost table, and omits most parcel endpoints. `docs/deployment.md` says the Lambdas are not in the VPC and cannot reach the database, and references `landfinder-db`. `docs/system-design-improvements.md` marks the SQS worker and bounding box search as "not yet implemented" (both are done), recommends RDS Proxy (superseded by the Data API), and points at the deleted listings scraper for tests. `docs/cost-pause-restore.md` contains the AWS account ID and resource IDs. The repo is private, but decide whether that belongs in git.

## Comments and documentation style

The user's standard is Google's developer documentation style guide. The rules that matter most for this codebase, from the guide's highlights page: second person, active voice, present tense, sentence case headings, and code font for identifiers. Applied to comments, that means a comment states what the code does or why in one or two sentences, and it does not narrate history, use "we", or decorate.

Patterns to change:

- **Banner comments.** `// -----` section dividers in `parcel/handler.ts` and `/* ─── Name ─── */` dividers in `index.css`. They exist because the files are too long. Splitting the files removes the need.
- **Narrative file headers.** `groundwater.ts:1` (16 lines, "We pull driller-reported wells... Verified live..."), `soil.ts:1`, and the scraper headers. Cut to one or two sentences that say what the module does and link the upstream API doc. Move "verified live" and field notes to a doc under `docs/data-sources.md`.
- **First person plural.** "our cadastral feed", "we send", "we hand to Bedrock". Rewrite as statements: "The cadastral feed...", "Sends the polygon to...".
- **Historical notes in code.** "EDGES/MapServer/0 was retired", "The ArcGIS REST facade on mrdata.usgs.gov was retired host-wide (404)", "Replaces Playwright-based scraping". These are changelog entries. Keep the current fact ("Layer 6 is secondary roads") and put the history in git or the data sources doc.
- **Punctuation.** Em dashes appear throughout comments and UI strings. The user's own rule is no em dashes and no semicolons in prose.
- **Comments that restate the code.** "Check cache", "Get parcel geometry and centroid", "Process in batches of BATCH_SIZE", "Main entry point", "Outputs". Delete them.
- **Comments that should be names.** `// 50 miles` next to `GAUGE_SEARCH_RADIUS_METERS = 80_467` becomes `const GAUGE_SEARCH_RADIUS_MILES = 50` and `milesToMeters(...)`. `// 30 days` next to a TTL becomes `days(30)`.

Comments worth keeping, as models: `db.ts:18` (why the resume retry exists), `handler.ts:478` (why POST instead of GET, with the observed failure), `handler.ts:570` (why `resultRecordCount` is omitted for USFS), `worker.ts:230` (why for-sale parcels sort first). Each explains a decision that the code alone cannot.

A before and after from `groundwater.ts`:

Before:

```
/**
 * Nearby well logs, on demand per parcel — MBMG GWIC (Ground Water Information Center).
 *
 * Well *logs* answer the question water rights can't: can you actually get water
 * here, and how deep / productive is it? We pull driller-reported wells within a
 * radius of the parcel and roll them up (median depth / yield / static water level)
 * as a "drillability" signal.
 * ... (10 more lines)
 */
```

After:

```
// Well logs within a radius of the parcel, from the DNRC Source Aquifer
// Explorer feature service (MBMG GWIC data). Median depth, yield, and static
// water level summarize whether a well is likely to succeed here.
// Field reference: <service>/0?f=json
```

## Vendors and external resources

Every external dependency, why it is a reasonable choice, what to watch, and what you would say if asked "why not X".

### AWS

| Service | Use | Assessment |
| --- | --- | --- |
| Cognito | Identity | Right tool at this scale. Free to 50k MAU. Weak spots are the admin-API proxy pattern and missing refresh (above). Alternative to name: Auth0 or Clerk, rejected on cost and on keeping everything in one account. |
| API Gateway REST | HTTP front door | Works, but the HTTP API (v2) is about 70 percent cheaper, lower latency, and has a built-in JWT authorizer. REST is justified by usage plans, request validation, or WAF, none of which you use. Be ready to say why you chose REST or migrate. |
| Lambda (Node 20, ARM) | Handlers | Good. ARM is the right cost choice. Domain-per-function with an internal router is a defensible middle ground between one monolith and one function per route. |
| Aurora Serverless v2 with Data API, min 0 ACU | Primary store | Strong choice for a low-traffic geospatial app: PostGIS, near-zero idle cost, no VPC networking for Lambdas, no NAT. Trade-offs to state: about 20 seconds resume from pause, Data API's 1 MB response limit and lack of native array parameters (handled in `db.ts`), and one round trip per statement. The 12-hour warmup ping is a pragmatic hack. RDS Proxy would be the answer if you moved back to VPC Lambdas. |
| DynamoDB | Users, search jobs | Users table is redundant with Cognito. Jobs table is justified by TTL and write-once semantics. |
| SQS standard plus worker Lambda | Async search | Correct reason (29-second API Gateway limit) and correct configuration (visibility 150s over a 120s timeout, DLQ, `reportBatchItemFailures`). |
| Step Functions plus ECS Fargate | Scrapers | Fargate is right for jobs over 15 minutes. Fix the parallel ordering. Public subnet with public IP to avoid NAT is a good cost decision to explain ($32 per month saved). No schedule is defined, so runs are manual. |
| Bedrock, Claude Haiku 4.5 via inference profile | Summaries and listing classification | Sensible model for cost. Two improvements: use the Converse API with a tool schema for the JSON classification instead of regex-extracting JSON from prose (`bedrock.ts:221`), and log prompt and response token counts so you can talk about cost per parcel. |
| Secrets Manager, X-Ray, Powertools, CloudWatch alarms, SNS | Ops | Good. This is the part that answers the "have you been on call" question. |
| S3 plus CloudFront | Web hosting | Standard. Cache policies split by HTML and hashed assets is correct. |

### Third-party services

| Service | Use | Assessment |
| --- | --- | --- |
| Serper.dev | Google results for "is this for sale" | Cheap and simple, but it is a Google scraper and Google's terms prohibit that, so an interviewer may ask. Alternatives: Brave Search API (official, cheap), Tavily or Exa (built for LLM use). Bing Web Search was retired in 2025. Whatever you pick, the classification has no evaluation set. Log 50 labeled cases and report precision. |
| CARTO Voyager basemap | Map tiles | Free with attribution for the current terms. Verify the license for a public deployment. MapLibre over Mapbox GL is the right call (no token, no billing). |
| Google Fonts | Typography | Fine. Self-host if you want no third-party request on first paint. |
| Nominatim (OpenStreetMap) | Geocoder of last resort | Usage policy allows light use with a contact User-Agent, which you have. Move the email to an env var. |
| `@hcsneden/design-library` | UI components | Your own package. The 30 overrides in `index.css` say it needs theme tokens or more variants. |

### Government data sources

All of these are free, unauthenticated, and prone to moving. Three have already moved once during this project (TIGER EDGES, USGS MRDS, USFS RoadCore), which the code comments record. That is the argument for one `dataSources.ts` registry (URL, layer, timeout, field list) and a scheduled smoke test that runs one known query per source and alarms when a source breaks. Being able to say "each upstream is health-checked nightly" is the support story.

| Source | Used for | Notes |
| --- | --- | --- |
| Montana cadastral (two services: `gisservice.mt.gov` MSDI and `gis.dnrc.mt.gov` Cadastral_Parcels) | Parcel lookup and bulk load | Pick one. Field names and the `geo_id` meaning differ between them. The mt.gov chain is why TLS is disabled. |
| Montana Structures/Addresses (E911 points) | House-number to parcel | Good secondary path. |
| DNRC WRQS (geocode and place-of-use layers) | Water rights | The core value of the product. Merging the two layers by right number is a good design. |
| MT FWP hunting districts | District overlap | Layer IDs are hardcoded (`hunting-districts/index.ts:24`). Verify them in the smoke test. |
| USGS NWIS site and daily values (`waterservices.usgs.gov`) | Stream gauges | Your scraper header says this is being decommissioned in early 2027 with `api.waterdata.usgs.gov` as the replacement. Plan the migration. |
| US Census TIGERweb Transportation, BLM routes, USFS RoadCore (AGOL mirror) | Road access | Reasonable trio. The USFS layer is a static snapshot, so note the vintage in the UI. |
| HIFLD transmission lines and retail service territories | Electric | HIFLD Open reorganized its hosting in 2025. Verify these two AGOL item URLs still resolve. |
| FEMA NFHL and National Risk Index | Flood and wildfire | Standard and stable. Wildfire is census-tract resolution, which the UI notes. |
| USGS MRDS (compact hosted service) | Mine sites | Already migrated once. Field set is narrower than before. |
| NCED (via Esri AGOL) | Conservation easements | Good source. Envelope search at 0.05 degrees is about 3 miles, which is coarse. Say so or intersect the parcel polygon. |
| NRCS Soil Data Access | Soils | Reliable. `percentOfParcel` is null and `primeFarmlandPercent` counts units instead of area. Either do the clip in SDA or label it "by map unit count". |
| DNRC Source Aquifer Explorer (AGOL) | Well logs | Good find. |
| US Census geocoder | Address to point | Free and official. First in the chain, which is right. |
| FWS NWI and BLM surface management (WMS) | Map overlays | Fine as raster overlays. |
| FCC broadband | Retired | The point lookup is gone. Either ingest the BDC bulk data or remove the feature. |

## Suggested order of work

1. Security and correctness list above. One day.
2. ESLint flat config with typescript-eslint and react-hooks, a GitHub Actions workflow running typecheck, lint, and tests. Half a day.
3. Extract `withParcelCache`, `parcelSearchGeometry`, `toParcel`, and the ArcGIS helpers, then split `parcel/handler.ts` into source modules. One to two days. This is the change that makes the code "senior".
4. Vitest suites for the pure functions: `toDataApiStatement` and `decodeRecords`, address parsing in lookup, the search SQL builder, flood and road classification, `splitStatements`, and the listing status JSON parsing. One day.
5. Remove dead listing, broadband, users-table, and schema artifacts. Half a day.
6. Move shared parsing to `packages/shared`, add `packages/api-client`, then decide the mobile app's fate. One day if you keep it, one hour if you park it.
7. Rewrite comments to the style above and update the README and docs to the current architecture. Half a day.
8. Data source registry and nightly smoke test. Half a day.
