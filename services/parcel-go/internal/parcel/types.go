package parcel

import "errors"

// Sentinel errors the HTTP layer maps to status codes.
var (
	ErrBadRequest = errors.New("bad request")
	ErrNotFound   = errors.New("parcel not found")
	ErrTimeout    = errors.New("gis lookup timed out")
)

// CadastralFeature mirrors a single ArcGIS feature from the Montana cadastral layer.
type CadastralFeature struct {
	Attributes CadastralAttributes `json:"attributes"`
	Geometry   *EsriPolygon        `json:"geometry,omitempty"`
}

// CadastralAttributes are the parcel fields requested via outFields.
type CadastralAttributes struct {
	ParcelID           string   `json:"PARCELID"`
	CountyName         *string  `json:"CountyName"`
	AddressLine1       *string  `json:"AddressLine1"`
	CityStateZip       *string  `json:"CityStateZip"`
	TotalAcres         *float64 `json:"TotalAcres"`
	GISAcres           *float64 `json:"GISAcres"`
	TotalBuildingValue *float64 `json:"TotalBuildingValue"`
	PropType           *string  `json:"PropType"`
}

// EsriPolygon is the ArcGIS rings geometry: rings[ring][point][x,y].
type EsriPolygon struct {
	Rings [][][]float64 `json:"rings"`
}

// LatLng is a WGS84 coordinate pair.
type LatLng struct {
	Lat float64
	Lng float64
}

// Parcel is the persisted, API-facing representation.
type Parcel struct {
	ID            string   `json:"id"`
	State         string   `json:"state"`
	County        *string  `json:"county"`
	ParcelNumber  *string  `json:"parcelNumber"`
	GeoID         *string  `json:"geoId"`
	Address       *string  `json:"address"`
	Acreage       *float64 `json:"acreage"`
	BuildingValue *float64 `json:"buildingValue"`
	PropType      *string  `json:"propType"`
	Coordinates   *LatLng  `json:"coordinates"`
	Boundary      any      `json:"boundary"` // GeoJSON geometry, decoded from PostGIS
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

// Candidate is a lightweight parcel summary returned when a TBD address matches
// multiple parcels on the same road.
type Candidate struct {
	ParcelID string   `json:"parcelId"`
	Address  *string  `json:"address"`
	Acreage  *float64 `json:"acreage"`
	County   *string  `json:"county"`
}

// WaterType classifies the source of a water right.
type WaterType string

const (
	WaterTypeSurface     WaterType = "surface"
	WaterTypeGroundwater WaterType = "groundwater"
	WaterTypeMixed       WaterType = "mixed"
)

// WaterStatus is the normalized lifecycle state of a water right.
type WaterStatus string

const (
	StatusActive   WaterStatus = "active"
	StatusInactive WaterStatus = "inactive"
	StatusPending  WaterStatus = "pending"
	StatusUnknown  WaterStatus = "unknown"
)

// MergedRight is a water right reconciled across the DNRC geocode and
// place-of-use layers.
type MergedRight struct {
	WRNumber     string
	WaterSource  *string
	WaterType    WaterType
	FlowRateGPM  *float64
	Volume       *float64
	PriorityDate *string // YYYY-MM-DD
	Status       WaterStatus
	RawData      map[string]any
}
