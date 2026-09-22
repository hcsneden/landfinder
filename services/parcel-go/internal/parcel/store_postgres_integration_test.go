//go:build integration

package parcel

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// defaultDSN matches docker-compose.yml; override with DATABASE_URL.
const defaultDSN = "postgres://landfinder:landfinder@localhost:5433/landfinder?sslmode=disable"

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = defaultDSN
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v (is `docker compose up -d` running?)", err)
	}
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v (is `docker compose up -d` running?)", err)
	}
	return pool
}

func sp(s string) *string   { return &s }
func fp(f float64) *float64 { return &f }

// TestIntegration_RoundTrip exercises the real PostGIS upsert path: it writes a
// parcel with a polygon boundary, verifies the GeoJSON/centroid round-trip,
// upserts water rights, and confirms ON CONFLICT updates behave.
func TestIntegration_RoundTrip(t *testing.T) {
	pool := testPool(t)
	defer pool.Close()
	ctx := context.Background()

	// Clean slate for a deterministic run.
	if _, err := pool.Exec(ctx, "DELETE FROM parcels WHERE parcel_number = $1", "IT-0001"); err != nil {
		t.Fatalf("cleanup: %v", err)
	}

	store := NewPostgresStore(pool)

	feature := CadastralFeature{
		Attributes: CadastralAttributes{
			ParcelID:           "IT-0001",
			CountyName:         sp("Gallatin"),
			AddressLine1:       sp("123 Bridger Canyon Rd"),
			CityStateZip:       sp("Bozeman, MT 59715"),
			TotalAcres:         fp(40.5),
			TotalBuildingValue: fp(250000),
			PropType:           sp("Residential"),
		},
		Geometry: &EsriPolygon{Rings: [][][]float64{{
			{-111.00, 45.00}, {-111.00, 45.10}, {-110.90, 45.10}, {-110.90, 45.00}, {-111.00, 45.00},
		}}},
	}

	// --- insert ---
	p, err := store.UpsertParcel(ctx, feature)
	if err != nil {
		t.Fatalf("UpsertParcel insert: %v", err)
	}
	if p.ID == "" {
		t.Fatal("expected a generated id")
	}
	if p.County == nil || *p.County != "Gallatin" {
		t.Errorf("county = %v, want Gallatin", p.County)
	}
	if p.Acreage == nil || *p.Acreage != 40.5 {
		t.Errorf("acreage = %v, want 40.5", p.Acreage)
	}
	if p.Address == nil || *p.Address != "123 Bridger Canyon Rd, Bozeman, MT 59715" {
		t.Errorf("address = %v", p.Address)
	}

	// Centroid round-tripped through ST_MakePoint / ST_X / ST_Y.
	if p.Coordinates == nil {
		t.Fatal("expected coordinates")
	}
	if p.Coordinates.Lng < -110.96 || p.Coordinates.Lng > -110.94 ||
		p.Coordinates.Lat < 45.04 || p.Coordinates.Lat > 45.06 {
		t.Errorf("centroid = %+v, want ~{-110.95, 45.05}", p.Coordinates)
	}

	// Boundary round-tripped through ST_GeomFromGeoJSON / ST_AsGeoJSON.
	geo, ok := p.Boundary.(map[string]any)
	if !ok || geo["type"] != "Polygon" {
		t.Fatalf("boundary not a GeoJSON polygon: %#v", p.Boundary)
	}

	// --- water rights upsert ---
	rights := []MergedRight{{
		WRNumber:     "76H 30012345",
		WaterSource:  sp("Bridger Creek"),
		WaterType:    WaterTypeSurface,
		FlowRateGPM:  fp(120),
		Status:       StatusActive,
		PriorityDate: sp("1889-11-08"),
		RawData:      map[string]any{"source": "dnrc_geocode"},
	}}
	if err := store.UpsertWaterRights(ctx, p.ID, rights); err != nil {
		t.Fatalf("UpsertWaterRights: %v", err)
	}

	var count int
	var source string
	if err := pool.QueryRow(ctx,
		"SELECT count(*), max(water_source) FROM water_rights WHERE parcel_id = $1", p.ID,
	).Scan(&count, &source); err != nil {
		t.Fatalf("query water rights: %v", err)
	}
	if count != 1 || source != "Bridger Creek" {
		t.Errorf("water rights = (count %d, source %q), want (1, Bridger Creek)", count, source)
	}

	// --- ON CONFLICT update: re-upsert with new building value ---
	feature.Attributes.TotalBuildingValue = fp(275000)
	p2, err := store.UpsertParcel(ctx, feature)
	if err != nil {
		t.Fatalf("UpsertParcel update: %v", err)
	}
	if p2.ID != p.ID {
		t.Errorf("expected same id on conflict, got %s vs %s", p2.ID, p.ID)
	}
	if p2.BuildingValue == nil || *p2.BuildingValue != 275000 {
		t.Errorf("building_value = %v, want 275000 after update", p2.BuildingValue)
	}
}
