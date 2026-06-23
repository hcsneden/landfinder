-- LandFinder Initial Database Schema
-- PostgreSQL with PostGIS extension

-- Enable PostGIS for geographic data
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Core parcel table
CREATE TABLE IF NOT EXISTS parcels (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    state VARCHAR(2) NOT NULL,
    county VARCHAR(100),
    parcel_number VARCHAR(100),
    geo_id VARCHAR(100),
    address TEXT,
    acreage DECIMAL(10,2),
    coordinates GEOGRAPHY(POINT, 4326),
    boundary GEOGRAPHY(POLYGON, 4326),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(state, parcel_number)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_parcels_state ON parcels(state);
CREATE INDEX IF NOT EXISTS idx_parcels_county ON parcels(county);
CREATE INDEX IF NOT EXISTS idx_parcels_acreage ON parcels(acreage);
CREATE INDEX IF NOT EXISTS idx_parcels_updated ON parcels(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_parcels_coordinates ON parcels USING GIST(coordinates);
CREATE INDEX IF NOT EXISTS idx_parcels_boundary ON parcels USING GIST(boundary);

-- Water rights linked to parcels
CREATE TABLE IF NOT EXISTS water_rights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    water_right_number VARCHAR(100),
    water_source VARCHAR(200),
    water_type VARCHAR(50), -- surface, groundwater, mixed
    flow_rate DECIMAL(10,2), -- gallons per minute
    volume DECIMAL(10,2), -- acre-feet
    priority_date DATE,
    status VARCHAR(50) DEFAULT 'unknown',
    raw_data JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(parcel_id, water_right_number)
);

CREATE INDEX IF NOT EXISTS idx_water_rights_parcel ON water_rights(parcel_id);
CREATE INDEX IF NOT EXISTS idx_water_rights_status ON water_rights(status);
CREATE INDEX IF NOT EXISTS idx_water_rights_type ON water_rights(water_type);

-- Listings from various sources
CREATE TABLE IF NOT EXISTS listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_id UUID REFERENCES parcels(id) ON DELETE SET NULL,
    source VARCHAR(50) NOT NULL, -- landwatch, land.com, etc
    source_id VARCHAR(200) NOT NULL,
    price DECIMAL(12,2),
    listing_url TEXT,
    description TEXT,
    images TEXT[] DEFAULT '{}',
    listed_at TIMESTAMP WITH TIME ZONE,
    scraped_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    raw_data JSONB DEFAULT '{}',
    UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_parcel ON listings(parcel_id);
CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source);
CREATE INDEX IF NOT EXISTS idx_listings_price ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_scraped ON listings(scraped_at DESC);

-- AI-generated insights
CREATE TABLE IF NOT EXISTS parcel_insights (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    insight_type VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    model_version VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insights_parcel ON parcel_insights(parcel_id);
CREATE INDEX IF NOT EXISTS idx_insights_type ON parcel_insights(insight_type);

-- User saved parcels
CREATE TABLE IF NOT EXISTS user_saved_parcels (
    user_id VARCHAR(100) NOT NULL, -- Cognito sub
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    notes TEXT,
    saved_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_user ON user_saved_parcels(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_parcel ON user_saved_parcels(parcel_id);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for parcels table
DROP TRIGGER IF EXISTS update_parcels_updated_at ON parcels;
CREATE TRIGGER update_parcels_updated_at
    BEFORE UPDATE ON parcels
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Full text search on parcels
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION parcels_search_vector_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.address, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.county, '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.parcel_number, '')), 'C');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS parcels_search_vector_trigger ON parcels;
CREATE TRIGGER parcels_search_vector_trigger
    BEFORE INSERT OR UPDATE ON parcels
    FOR EACH ROW
    EXECUTE FUNCTION parcels_search_vector_update();

CREATE INDEX IF NOT EXISTS idx_parcels_search ON parcels USING GIN(search_vector);

-- View for search results with water rights status
CREATE OR REPLACE VIEW parcel_search_view AS
SELECT
    p.id,
    p.state,
    p.county,
    p.parcel_number,
    p.geo_id,
    p.address,
    p.acreage,
    ST_X(p.coordinates::geometry) as longitude,
    ST_Y(p.coordinates::geometry) as latitude,
    p.created_at,
    p.updated_at,
    COALESCE(
        (SELECT json_agg(json_build_object(
            'id', l.id,
            'source', l.source,
            'price', l.price,
            'listing_url', l.listing_url
        ))
        FROM listings l WHERE l.parcel_id = p.id),
        '[]'
    ) as listings,
    EXISTS(SELECT 1 FROM water_rights wr WHERE wr.parcel_id = p.id) as has_water_rights,
    (SELECT COUNT(*) FROM water_rights wr WHERE wr.parcel_id = p.id) as water_rights_count
FROM parcels p;

COMMENT ON TABLE parcels IS 'Core parcel data from Montana Cadastral and other sources';
COMMENT ON TABLE water_rights IS 'Water rights from DNRC linked to parcels';
COMMENT ON TABLE listings IS 'Land listings aggregated from multiple sources';
COMMENT ON TABLE parcel_insights IS 'AI-generated insights and analysis for parcels';
COMMENT ON TABLE user_saved_parcels IS 'User saved/favorited parcels';
