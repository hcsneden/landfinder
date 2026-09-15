package parcel

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresStore persists parcels to PostgreSQL/PostGIS via pgx.
type PostgresStore struct {
	pool *pgxpool.Pool
}

// NewPostgresStore wraps a pgx pool.
func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{pool: pool}
}

// The SQL is intentionally static (no dynamically-built placeholders) so the
// server can cache the prepared statement. NULL coordinate/boundary handling is
// pushed into CASE expressions rather than string concatenation.
const upsertParcelSQL = `
INSERT INTO parcels (state, county, parcel_number, geo_id, address, acreage,
	building_value, prop_type, coordinates, boundary, created_at, updated_at)
VALUES ('MT', $1, $2, $2, $3, $4, $5, $6,
	CASE WHEN $7::float8 IS NULL OR $8::float8 IS NULL THEN NULL
	     ELSE ST_SetSRID(ST_MakePoint($7, $8), 4326) END,
	CASE WHEN $9::text IS NULL THEN NULL
	     ELSE ST_GeomFromGeoJSON($9) END,
	NOW(), NOW())
ON CONFLICT (state, parcel_number) DO UPDATE SET
	county = EXCLUDED.county, geo_id = EXCLUDED.geo_id, address = EXCLUDED.address,
	acreage = EXCLUDED.acreage, building_value = EXCLUDED.building_value,
	prop_type = EXCLUDED.prop_type,
	coordinates = COALESCE(EXCLUDED.coordinates, parcels.coordinates),
	boundary = COALESCE(EXCLUDED.boundary, parcels.boundary),
	updated_at = NOW()
RETURNING id, state, county, parcel_number, geo_id, address, acreage,
	building_value, prop_type,
	ST_X(coordinates::geometry) AS lng, ST_Y(coordinates::geometry) AS lat,
	ST_AsGeoJSON(boundary)::text AS boundary,
	created_at::text, updated_at::text`

// UpsertParcel inserts or updates the parcel and returns the persisted row.
func (s *PostgresStore) UpsertParcel(ctx context.Context, f CadastralFeature) (*Parcel, error) {
	a := f.Attributes

	var lat, lng *float64
	var boundaryJSON *string
	if f.Geometry != nil && len(f.Geometry.Rings) > 0 {
		b, err := json.Marshal(map[string]any{"type": "Polygon", "coordinates": f.Geometry.Rings})
		if err != nil {
			return nil, fmt.Errorf("marshal boundary: %w", err)
		}
		js := string(b)
		boundaryJSON = &js
		if c, ok := Centroid(f.Geometry.Rings); ok {
			lat, lng = &c.Lat, &c.Lng
		}
	}

	row := s.pool.QueryRow(ctx, upsertParcelSQL,
		a.CountyName, a.ParcelID, formatAddress(a), acreage(a),
		a.TotalBuildingValue, a.PropType, lng, lat, boundaryJSON)

	var p Parcel
	var lngOut, latOut *float64
	var boundaryOut *string
	if err := row.Scan(&p.ID, &p.State, &p.County, &p.ParcelNumber, &p.GeoID,
		&p.Address, &p.Acreage, &p.BuildingValue, &p.PropType,
		&lngOut, &latOut, &boundaryOut, &p.CreatedAt, &p.UpdatedAt); err != nil {
		return nil, fmt.Errorf("upsert parcel: %w", err)
	}
	if latOut != nil && lngOut != nil {
		p.Coordinates = &LatLng{Lat: *latOut, Lng: *lngOut}
	}
	if boundaryOut != nil {
		_ = json.Unmarshal([]byte(*boundaryOut), &p.Boundary)
	}
	return &p, nil
}

// The bulk insert uses unnest() so all merged rights go in one round-trip,
// mirroring the original service's array-parameter insert.
const upsertWaterRightsSQL = `
INSERT INTO water_rights
	(parcel_id, water_right_number, water_source, water_type, flow_rate, volume, priority_date, status, raw_data)
SELECT $1, unnest($2::text[]), unnest($3::text[]), unnest($4::text[]),
	unnest($5::numeric[]), unnest($6::numeric[]), unnest($7::date[]),
	unnest($8::text[]), unnest($9::jsonb[])
ON CONFLICT (parcel_id, water_right_number) DO UPDATE SET
	water_source  = COALESCE(EXCLUDED.water_source, water_rights.water_source),
	flow_rate     = COALESCE(EXCLUDED.flow_rate, water_rights.flow_rate),
	volume        = COALESCE(EXCLUDED.volume, water_rights.volume),
	priority_date = COALESCE(EXCLUDED.priority_date, water_rights.priority_date),
	status        = EXCLUDED.status,
	raw_data      = water_rights.raw_data || EXCLUDED.raw_data`

// UpsertWaterRights bulk-inserts merged rights for a parcel.
func (s *PostgresStore) UpsertWaterRights(ctx context.Context, parcelID string, rights []MergedRight) error {
	n := len(rights)
	numbers := make([]string, n)
	sources := make([]*string, n)
	types := make([]string, n)
	flows := make([]*float64, n)
	volumes := make([]*float64, n)
	dates := make([]*string, n)
	statuses := make([]string, n)
	raw := make([]string, n)

	for i, r := range rights {
		numbers[i] = r.WRNumber
		sources[i] = r.WaterSource
		types[i] = string(r.WaterType)
		flows[i] = r.FlowRateGPM
		volumes[i] = r.Volume
		dates[i] = r.PriorityDate
		statuses[i] = string(r.Status)
		b, err := json.Marshal(r.RawData)
		if err != nil {
			return fmt.Errorf("marshal raw_data: %w", err)
		}
		raw[i] = string(b)
	}

	_, err := s.pool.Exec(ctx, upsertWaterRightsSQL,
		parcelID, numbers, sources, types, flows, volumes, dates, statuses, raw)
	if err != nil {
		return fmt.Errorf("upsert water rights: %w", err)
	}
	return nil
}
