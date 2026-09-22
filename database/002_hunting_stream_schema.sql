-- Montana FWP hunting district boundaries and USGS stream gauges.

-- GEOGRAPHY(GEOMETRY) admits both POLYGON and MULTIPOLYGON. Some districts are non-contiguous.
CREATE TABLE IF NOT EXISTS hunting_districts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  district_number VARCHAR(20) NOT NULL,
  species VARCHAR(50) NOT NULL DEFAULT 'general',
  boundary GEOGRAPHY(GEOMETRY, 4326),
  raw_data JSONB DEFAULT '{}',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(district_number, species)
);

CREATE INDEX IF NOT EXISTS idx_hunting_districts_boundary ON hunting_districts USING GIST(boundary);

CREATE TABLE IF NOT EXISTS stream_gauges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_number VARCHAR(20) NOT NULL UNIQUE,
  site_name TEXT NOT NULL,
  stream_name TEXT,
  coordinates GEOGRAPHY(POINT, 4326),
  county_cd VARCHAR(10),
  huc_code VARCHAR(20),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stream_gauges_coordinates ON stream_gauges USING GIST(coordinates);

-- Daily mean streamflow (USGS parameter 00060, statistic 00003).
CREATE TABLE IF NOT EXISTS stream_gauge_readings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  gauge_id UUID REFERENCES stream_gauges(id) ON DELETE CASCADE,
  reading_date DATE NOT NULL,
  mean_flow_cfs DECIMAL(12, 2),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(gauge_id, reading_date)
);

CREATE INDEX IF NOT EXISTS idx_gauge_readings_gauge_date ON stream_gauge_readings(gauge_id, reading_date DESC);
