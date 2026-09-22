-- Removes tables and objects that no code reads or writes.
-- The per-source cache tables were replaced by parcel_enrichment_cache, so
-- their contents are re-fetched on demand after this runs.

DROP TABLE IF EXISTS road_access_cache;
DROP TABLE IF EXISTS utility_access_cache;
DROP TABLE IF EXISTS environmental_risk_cache;
DROP TABLE IF EXISTS conservation_easement_cache;
DROP TABLE IF EXISTS soil_info_cache;
DROP TABLE IF EXISTS groundwater_cache;

-- The listing feed was never licensed. For-sale status comes from listing_status_cache.
DROP VIEW IF EXISTS parcel_search_view;
DROP TABLE IF EXISTS listings;

-- Full-text search on parcels was never queried.
DROP TRIGGER IF EXISTS parcels_search_vector_trigger ON parcels;
DROP FUNCTION IF EXISTS parcels_search_vector_update();
DROP INDEX IF EXISTS idx_parcels_search;
ALTER TABLE parcels DROP COLUMN IF EXISTS search_vector;

-- Redundant with the primary key prefix and with unused filters.
DROP INDEX IF EXISTS idx_saved_user;
DROP INDEX IF EXISTS idx_water_rights_status;
DROP INDEX IF EXISTS idx_water_rights_type;
DROP INDEX IF EXISTS idx_insights_type;
DROP INDEX IF EXISTS idx_hunting_districts_number;
DROP INDEX IF EXISTS idx_hunting_districts_species;
