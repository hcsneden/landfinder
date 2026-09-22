-- Core schema: parcels, their water rights, AI insights, and saved parcels.
-- Every statement is idempotent so the migration Lambda can run the full set.

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(state, parcel_number)
);

ALTER TABLE parcels ADD COLUMN IF NOT EXISTS building_value DECIMAL(12,2);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS prop_type VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_parcels_state ON parcels(state);
CREATE INDEX IF NOT EXISTS idx_parcels_county ON parcels(county);
CREATE INDEX IF NOT EXISTS idx_parcels_acreage ON parcels(acreage);
CREATE INDEX IF NOT EXISTS idx_parcels_updated ON parcels(updated_at DESC);
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(parcel_id, water_right_number)
);

CREATE INDEX IF NOT EXISTS idx_water_rights_parcel ON water_rights(parcel_id);

CREATE TABLE IF NOT EXISTS parcel_insights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    insight_type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    model_version VARCHAR(80),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_parcel ON parcel_insights(parcel_id);

CREATE TABLE IF NOT EXISTS user_saved_parcels (
    user_id VARCHAR(100) NOT NULL,
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    notes TEXT,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_parcel ON user_saved_parcels(parcel_id);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_parcels_updated_at ON parcels;
CREATE TRIGGER update_parcels_updated_at
    BEFORE UPDATE ON parcels
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
