# parcel-go

A Go port of LandFinder's parcel-lookup service — a geospatial backend that
resolves a free-text address or parcel ID to a Montana cadastral parcel,
persists it to PostgreSQL/PostGIS, and seeds the parcel's DNRC water rights.

Ported from the original TypeScript Lambda (`services/api/parcel/lookup.ts`) to
demonstrate the same geospatial pipeline as an idiomatic, container-ready Go
microservice.

## What it does

`GET /parcels/lookup?q=<address-or-parcel-id>` runs a resolution cascade:

1. **TBD/road-name search** — addresses like `TBD Arcturus Dr` (no house number)
   are matched by road; multiple hits return a candidate list.
2. **Cadastral LIKE match** — on address or parcel ID against the MT cadastral
   ArcGIS layer.
3. **E911 address point** — resolves a street address to a parcel ID via the
   Montana Structures/Addresses layer.
4. **Geocode → spatial fallback** — US Census (oneline → structured) → Nominatim,
   then a point-in-polygon query against the cadastral layer.

On a match it upserts the parcel into PostGIS (`ST_MakePoint`, `ST_GeomFromGeoJSON`,
returning `ST_AsGeoJSON`) and concurrently fetches the DNRC geocode + place-of-use
water-right layers, merging them by water-right number.

## Layout

```
cmd/parcel/            HTTP server entrypoint (slog, pgxpool, net/http)
internal/arcgis/       Shared GIS HTTP client (context timeouts, MT CA handling)
internal/parcel/
  service.go           Lookup cascade orchestration
  cadastral.go         Cadastral + address-point ArcGIS queries
  geocode.go           Census → Nominatim geocoder cascade
  waterrights.go       Concurrent WRQS fetch + merge
  store_postgres.go    PostGIS upsert via pgx (static, cache-friendly SQL)
  geom.go              Centroid, address parsing, pure helpers
  http.go              Transport handler + error→status mapping
```

## Run

```bash
go test ./...                      # unit + httptest tests (no DB, no network)
DATABASE_URL=postgres://... go run ./cmd/parcel
```

The `Store` is an interface; the unit tests use an in-memory fake, so the full
lookup cascade is exercised against an `httptest` ArcGIS server with zero
external dependencies.

## Integration test (real PostGIS)

A `//go:build integration` test round-trips a parcel through PostGIS — verifying
the `ST_MakePoint`/`ST_AsGeoJSON` centroid + boundary conversions, the
water-rights bulk upsert, and `ON CONFLICT` update behavior — against a
throwaway container:

```bash
docker compose up -d                         # PostGIS 16 + PostGIS 3.4 on :5433
DATABASE_URL="postgres://landfinder:landfinder@localhost:5433/landfinder?sslmode=disable" \
  go test -tags integration ./internal/parcel/ -run Integration -v
docker compose down
```

The `integration` build tag keeps this out of the default `go test ./...` run,
so CI without Docker stays green.

## Container

```bash
docker build -t parcel-go .                  # distroless static image, ~nonroot
```

## Notes for reviewers

Patterns chosen to mirror production Go services:

- **`context.Context`** threads request deadlines through every GIS call.
- **`sync.WaitGroup`** fan-out for the two water-right layers (swap for
  `errgroup` once joined error semantics are needed).
- **Static SQL with `CASE WHEN $n IS NULL`** instead of dynamically-built
  placeholder strings — keeps the prepared statement cacheable.
- **Pure functions** (`Centroid`, `mergeRights`, `parseStatus`, …) are unit
  tested without mocks; transport paths use `httptest`.
