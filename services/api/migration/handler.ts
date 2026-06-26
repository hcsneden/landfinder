import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});

const SCHEMA_SQL = `
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
    coordinates GEOGRAPHY(POINT, 4326),
    boundary GEOGRAPHY(POLYGON, 4326),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(state, parcel_number)
);

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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(parcel_id, water_right_number)
);

CREATE INDEX IF NOT EXISTS idx_water_rights_parcel ON water_rights(parcel_id);
CREATE INDEX IF NOT EXISTS idx_water_rights_status ON water_rights(status);
CREATE INDEX IF NOT EXISTS idx_water_rights_type ON water_rights(water_type);

CREATE TABLE IF NOT EXISTS listings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parcel_id UUID REFERENCES parcels(id) ON DELETE SET NULL,
    source VARCHAR(50) NOT NULL,
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

CREATE TABLE IF NOT EXISTS user_saved_parcels (
    user_id VARCHAR(100) NOT NULL,
    parcel_id UUID REFERENCES parcels(id) ON DELETE CASCADE,
    notes TEXT,
    saved_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_user ON user_saved_parcels(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_parcel ON user_saved_parcels(parcel_id);

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_parcels_updated_at ON parcels;
CREATE TRIGGER update_parcels_updated_at
    BEFORE UPDATE ON parcels
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

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

-- Migration 002: Hunting Districts and Stream Gauges

CREATE TABLE IF NOT EXISTS hunting_districts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  district_number VARCHAR(20) NOT NULL,
  species VARCHAR(50) NOT NULL DEFAULT 'general',
  boundary GEOGRAPHY(GEOMETRY, 4326),
  raw_data JSONB DEFAULT '{}',
  fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(district_number, species)
);

CREATE INDEX IF NOT EXISTS idx_hunting_districts_boundary
  ON hunting_districts USING GIST(boundary);
CREATE INDEX IF NOT EXISTS idx_hunting_districts_number
  ON hunting_districts(district_number);
CREATE INDEX IF NOT EXISTS idx_hunting_districts_species
  ON hunting_districts(species);

CREATE TABLE IF NOT EXISTS stream_gauges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_number VARCHAR(20) NOT NULL UNIQUE,
  site_name TEXT NOT NULL,
  stream_name TEXT,
  coordinates GEOGRAPHY(POINT, 4326),
  county_cd VARCHAR(10),
  huc_code VARCHAR(20),
  fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stream_gauges_coordinates
  ON stream_gauges USING GIST(coordinates);

CREATE TABLE IF NOT EXISTS stream_gauge_readings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gauge_id UUID REFERENCES stream_gauges(id) ON DELETE CASCADE,
  reading_date DATE NOT NULL,
  mean_flow_cfs DECIMAL(12, 2),
  fetched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(gauge_id, reading_date)
);

CREATE INDEX IF NOT EXISTS idx_gauge_readings_gauge_date
  ON stream_gauge_readings(gauge_id, reading_date DESC);

-- Migration 003: Road Access Cache
CREATE TABLE IF NOT EXISTS road_access_cache (
  parcel_id  UUID PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
  roads      JSONB NOT NULL DEFAULT '[]',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function handler(): Promise<{ statusCode: number; body: string }> {
  const secretArn = process.env.DATABASE_SECRET_ARN;
  if (!secretArn) throw new Error('DATABASE_SECRET_ARN not set');

  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('No secret value returned');

  const creds = JSON.parse(response.SecretString) as {
    host: string; port: number; username: string; password: string; dbname: string;
  };

  const pool = new Pool({
    host: creds.host,
    port: creds.port,
    user: creds.username,
    password: creds.password,
    database: creds.dbname,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  try {
    console.log('Running schema migration...');
    await pool.query(SCHEMA_SQL);
    console.log('Migration completed successfully');
    return { statusCode: 200, body: 'Migration completed successfully' };
  } finally {
    await pool.end();
  }
}
