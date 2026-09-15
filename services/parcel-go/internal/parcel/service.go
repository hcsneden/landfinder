package parcel

import (
	"context"
	"fmt"
	"strings"

	"github.com/hsneden/landfinder/parcel-go/internal/arcgis"
)

// Logger is the minimal structured-logging surface the package needs; *slog.Logger
// satisfies it.
type Logger interface {
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
	Error(msg string, args ...any)
}

// Store persists parcels and their water rights. PostgresStore is the
// production implementation; tests use an in-memory fake.
type Store interface {
	UpsertParcel(ctx context.Context, f CadastralFeature) (*Parcel, error)
	UpsertWaterRights(ctx context.Context, parcelID string, rights []MergedRight) error
}

// Service orchestrates the lookup cascade.
type Service struct {
	gis   *arcgis.Client
	geo   *Geocoder
	store Store
	log   Logger
}

// New constructs a Service.
func New(gis *arcgis.Client, geo *Geocoder, store Store, log Logger) *Service {
	return &Service{gis: gis, geo: geo, store: store, log: log}
}

// LookupResult is the outcome of a lookup: exactly one of Parcel or Candidates
// is populated on success.
type LookupResult struct {
	Parcel     *Parcel     `json:"parcel,omitempty"`
	Candidates []Candidate `json:"candidates,omitempty"`
	RoadName   string      `json:"roadName,omitempty"`
}

// Lookup resolves a free-text query to a parcel, persisting it and seeding water
// rights. It returns ErrNotFound when nothing matches and ErrBadRequest for an
// invalid query.
func (s *Service) Lookup(ctx context.Context, q string) (*LookupResult, error) {
	q = strings.TrimSpace(q)
	if len(q) < 3 {
		return nil, fmt.Errorf(`%w: query "q" must be at least 3 characters`, ErrBadRequest)
	}

	// 1. TBD/0 addresses have no house number — search by road name.
	if isTBDAddress(q) {
		if road := extractRoadName(q); road != "" {
			cands, err := s.cadastralCandidates(ctx, road)
			if err != nil {
				return nil, err
			}
			switch {
			case len(cands) > 1:
				s.log.Info("tbd address returned candidates", "q", q, "road", road, "count", len(cands))
				return &LookupResult{Candidates: toCandidates(cands), RoadName: road}, nil
			case len(cands) == 1:
				return s.persist(ctx, cands[0])
			}
			// 0 results → fall through to the other strategies.
		}
	}

	// 2. Cadastral LIKE match on address or parcel id.
	feature, err := s.cadastralByQuery(ctx, q)
	if err != nil {
		return nil, err
	}

	// 3. MT E911 address point → parcel id → cadastral.
	if feature == nil {
		if feature, err = s.byAddressPoint(ctx, q); err != nil {
			return nil, err
		}
	}

	// 4. Geocode cascade → point-in-polygon spatial query.
	if feature == nil {
		if ll, ok := s.geo.Geocode(ctx, q); ok {
			s.log.Info("geocode hit, spatial fallback", "q", q, "lat", ll.Lat, "lng", ll.Lng)
			if feature, err = s.cadastralByPoint(ctx, ll); err != nil {
				return nil, err
			}
		}
	}

	if feature == nil {
		return nil, ErrNotFound
	}
	return s.persist(ctx, *feature)
}

// persist upserts the parcel and best-effort seeds its water rights.
func (s *Service) persist(ctx context.Context, f CadastralFeature) (*LookupResult, error) {
	p, err := s.store.UpsertParcel(ctx, f)
	if err != nil {
		return nil, err
	}
	if f.Attributes.ParcelID != "" {
		var rings [][][]float64
		if f.Geometry != nil {
			rings = f.Geometry.Rings
		}
		c, hasCentroid := Centroid(rings)
		if err := s.SeedWaterRights(ctx, p.ID, f.Attributes.ParcelID, rings, c, hasCentroid); err != nil {
			s.log.Warn("water rights seed failed", "parcelID", p.ID, "err", err) // non-fatal
		}
	}
	return &LookupResult{Parcel: p}, nil
}
