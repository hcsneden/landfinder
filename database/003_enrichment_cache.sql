-- Per-parcel cache of external data source results. One row per parcel and
-- source. Each source's TTL is enforced in the API.
CREATE TABLE IF NOT EXISTS parcel_enrichment_cache (
  parcel_id  UUID NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
  source     VARCHAR(40) NOT NULL,
  payload    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (parcel_id, source)
);

-- Keyed by the cadastral parcel number rather than parcels.id so candidates
-- from an ambiguous lookup can be checked before they are stored as parcels.
CREATE TABLE IF NOT EXISTS listing_status_cache (
  parcel_number TEXT PRIMARY KEY,
  for_sale      BOOLEAN NOT NULL,
  confidence    VARCHAR(10) NOT NULL,
  price         DECIMAL(12,2),
  listing_url   TEXT,
  source        VARCHAR(100),
  summary       TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
