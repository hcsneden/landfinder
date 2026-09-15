-- Self-contained schema for the parcel-go integration test.
-- Mirrors database/001_initial_schema.sql plus the building_value/prop_type
-- columns the lookup service writes (added out-of-band in the deployed DB).

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS parcels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    state VARCHAR(2) NOT NULL,
    county VARCHAR(100),
    parcel_number VARCHAR(100),
    geo_id VARCHAR(100),
    address TEXT,
    acreage DECIMAL(10,2),
    building_value DECIMAL(12,2),
    prop_type VARCHAR(100),
    coordinates GEOGRAPHY(POINT, 4326),
    boundary GEOGRAPHY(POLYGON, 4326),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(state, parcel_number)
);

CREATE INDEX IF NOT EXISTS idx_parcels_coordinates ON parcels USING GIST(coordinates);
CREATE INDEX IF NOT EXISTS idx_parcels_boundary ON parcels USING GIST(boundary);

CREATE TABLE IF NOT EXISTS water_rights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    water_right_number VARCHAR(100),
    water_source VARCHAR(200),
    water_type VARCHAR(50),
    flow_rate DECIMAL(10,2),
    volume DECIMAL(10,2),
    priority_date DATE,
    status VARCHAR(50) DEFAULT 'unknown',
    raw_data JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(parcel_id, water_right_number)
);

CREATE INDEX IF NOT EXISTS idx_water_rights_parcel ON water_rights(parcel_id);
