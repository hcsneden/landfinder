-- Migration 003: Road Access Cache
-- Stores results from TIGER/Line, BLM, and USFS road proximity queries per parcel.
-- TTL is enforced in application code (30 days); road networks change rarely.

CREATE TABLE IF NOT EXISTS road_access_cache (
  parcel_id  UUID PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
  roads      JSONB NOT NULL DEFAULT '[]',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
