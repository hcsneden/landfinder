package parcel

import (
	"context"
	"net/url"
	"strconv"

	"github.com/hsneden/landfinder/parcel-go/internal/arcgis"
)

const (
	censusOnelineURL   = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
	censusStructuredURL = "https://geocoding.geo.census.gov/geocoder/locations/address"
	nominatimURL       = "https://nominatim.openstreetmap.org/search"
)

// Geocoder resolves free-text addresses to coordinates via a cascade of
// providers, trying the most authoritative (US Census) first.
type Geocoder struct {
	gis *arcgis.Client
	log Logger
}

// NewGeocoder constructs a Geocoder.
func NewGeocoder(gis *arcgis.Client, log Logger) *Geocoder {
	return &Geocoder{gis: gis, log: log}
}

type censusResponse struct {
	Result struct {
		AddressMatches []struct {
			Coordinates struct {
				X float64 `json:"x"`
				Y float64 `json:"y"`
			} `json:"coordinates"`
		} `json:"addressMatches"`
	} `json:"result"`
}

func (r censusResponse) coords() (LatLng, bool) {
	if len(r.Result.AddressMatches) == 0 {
		return LatLng{}, false
	}
	c := r.Result.AddressMatches[0].Coordinates
	return LatLng{Lat: c.Y, Lng: c.X}, true
}

// Geocode tries each strategy in order and returns the first hit.
func (g *Geocoder) Geocode(ctx context.Context, q string) (LatLng, bool) {
	for _, fn := range []func(context.Context, string) (LatLng, bool){
		g.census,
		g.censusStructured,
		g.nominatim,
	} {
		if ll, ok := fn(ctx, q); ok {
			return ll, true
		}
	}
	return LatLng{}, false
}

func (g *Geocoder) census(ctx context.Context, q string) (LatLng, bool) {
	params := url.Values{"address": {q}, "benchmark": {"Public_AR_Current"}, "format": {"json"}}
	var resp censusResponse
	if err := g.gis.GetJSON(ctx, censusOnelineURL+"?"+params.Encode(), &resp); err != nil {
		g.log.Warn("census geocoder failed", "err", err)
		return LatLng{}, false
	}
	return resp.coords()
}

func (g *Geocoder) censusStructured(ctx context.Context, q string) (LatLng, bool) {
	parts, ok := parseAddressParts(q)
	if !ok {
		return LatLng{}, false
	}
	params := url.Values{
		"street":    {parts.Street},
		"city":      {parts.City},
		"state":     {parts.State},
		"benchmark": {"Public_AR_Current"},
		"format":    {"json"},
	}
	if parts.Zip != "" {
		params.Set("zip", parts.Zip)
	}
	var resp censusResponse
	if err := g.gis.GetJSON(ctx, censusStructuredURL+"?"+params.Encode(), &resp); err != nil {
		g.log.Warn("census structured geocoder failed", "err", err)
		return LatLng{}, false
	}
	return resp.coords()
}

func (g *Geocoder) nominatim(ctx context.Context, q string) (LatLng, bool) {
	params := url.Values{"q": {q}, "format": {"json"}, "limit": {"1"}, "countrycodes": {"us"}}
	var resp []struct {
		Lat string `json:"lat"`
		Lon string `json:"lon"`
	}
	if err := g.gis.GetJSON(ctx, nominatimURL+"?"+params.Encode(), &resp); err != nil {
		g.log.Warn("nominatim geocoder failed", "err", err)
		return LatLng{}, false
	}
	if len(resp) == 0 {
		return LatLng{}, false
	}
	lat, err1 := strconv.ParseFloat(resp[0].Lat, 64)
	lng, err2 := strconv.ParseFloat(resp[0].Lon, 64)
	if err1 != nil || err2 != nil {
		return LatLng{}, false
	}
	return LatLng{Lat: lat, Lng: lng}, true
}
