package parcel

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/hsneden/landfinder/parcel-go/internal/arcgis"
)

// fakeStore is an in-memory Store for tests.
type fakeStore struct {
	mu      sync.Mutex
	parcels []CadastralFeature
	rights  map[string][]MergedRight
}

func newFakeStore() *fakeStore { return &fakeStore{rights: map[string][]MergedRight{}} }

func (f *fakeStore) UpsertParcel(_ context.Context, feat CadastralFeature) (*Parcel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.parcels = append(f.parcels, feat)
	p := &Parcel{ID: "parcel-1", State: "MT", ParcelNumber: &feat.Attributes.ParcelID}
	if c, ok := Centroid(ringsOf(feat)); ok {
		p.Coordinates = &LatLng{Lat: c.Lat, Lng: c.Lng}
	}
	return p, nil
}

func (f *fakeStore) UpsertWaterRights(_ context.Context, parcelID string, r []MergedRight) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rights[parcelID] = r
	return nil
}

func ringsOf(f CadastralFeature) [][][]float64 {
	if f.Geometry == nil {
		return nil
	}
	return f.Geometry.Rings
}

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// newTestService wires a Service whose GIS calls hit the provided fake server.
func newTestService(t *testing.T, srv *httptest.Server) (*Service, *fakeStore) {
	t.Helper()
	// Rewrite every outbound GIS URL to the test server, preserving the path+query.
	rt := rewriteTransport{base: srv.URL, inner: srv.Client().Transport}
	client := arcgis.NewWithClient(&http.Client{Transport: rt})
	store := newFakeStore()
	log := discardLogger()
	return New(client, NewGeocoder(client, log), store, log), store
}

type rewriteTransport struct {
	base  string
	inner http.RoundTripper
}

func (rt rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	target, _ := http.NewRequestWithContext(req.Context(), req.Method, rt.base+req.URL.Path+"?"+req.URL.RawQuery, nil)
	target.Header = req.Header
	inner := rt.inner
	if inner == nil {
		inner = http.DefaultTransport
	}
	return inner.RoundTrip(target)
}

func TestLookup_CadastralMatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/msdi_cadastral_map_v1/"):
			io.WriteString(w, `{"features":[{"attributes":{"PARCELID":"49-1234","CountyName":"Gallatin","TotalAcres":40.5},"geometry":{"rings":[[[ -111.0,45.0],[-111.0,45.1],[-110.9,45.1],[-110.9,45.0],[-111.0,45.0]]]}}]}`)
		case strings.Contains(r.URL.Path, "/WRD/WRQS/"):
			io.WriteString(w, `{"features":[{"attributes":{"WR_NUMBER":"76H 100","SOURCE_TYPES":"GROUNDWATER","WR_STATUS":"ACTIVE"}}]}`)
		default:
			io.WriteString(w, `{"features":[]}`)
		}
	}))
	defer srv.Close()

	svc, store := newTestService(t, srv)
	res, err := svc.Lookup(context.Background(), "123 Bridger Canyon Rd, Bozeman, MT")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if res.Parcel == nil || res.Parcel.ParcelNumber == nil || *res.Parcel.ParcelNumber != "49-1234" {
		t.Fatalf("unexpected parcel: %+v", res.Parcel)
	}
	if res.Parcel.Coordinates == nil {
		t.Error("expected centroid coordinates to be set")
	}
	if got := store.rights["parcel-1"]; len(got) != 1 || got[0].WRNumber != "76H 100" {
		t.Errorf("expected seeded water right, got %+v", got)
	}
}

func TestLookup_TBDReturnsCandidates(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"features":[
			{"attributes":{"PARCELID":"A","AddressLine1":"Arcturus Dr","TotalAcres":20}},
			{"attributes":{"PARCELID":"B","AddressLine1":"Arcturus Dr","TotalAcres":10}}
		]}`)
	}))
	defer srv.Close()

	svc, _ := newTestService(t, srv)
	res, err := svc.Lookup(context.Background(), "TBD Arcturus Dr, Emigrant, MT 59027")
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if res.Parcel != nil {
		t.Fatal("expected candidates, not a resolved parcel")
	}
	if len(res.Candidates) != 2 || res.RoadName != "Arcturus Dr" {
		t.Errorf("got %d candidates, road %q", len(res.Candidates), res.RoadName)
	}
}

func TestLookup_NotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"features":[]}`)
	}))
	defer srv.Close()

	svc, _ := newTestService(t, srv)
	_, err := svc.Lookup(context.Background(), "999 Nowhere Rd, Nowhere, MT")
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

func TestLookup_ShortQueryRejected(t *testing.T) {
	svc, _ := newTestService(t, httptest.NewServer(http.NotFoundHandler()))
	_, err := svc.Lookup(context.Background(), "ab")
	if err == nil || !strings.Contains(err.Error(), "bad request") {
		t.Fatalf("expected ErrBadRequest, got %v", err)
	}
}
