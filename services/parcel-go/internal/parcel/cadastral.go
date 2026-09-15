package parcel

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
)

// Endpoint URLs for the Montana state GIS services.
const (
	cadastralURL  = "https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0/query"
	msdiAddressURL = "https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/MontanaStructuresAddresses/MapServer/0/query"
)

const cadastralFields = "PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType"

// arcgisError is the error envelope ArcGIS returns with HTTP 200.
type arcgisError struct {
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type cadastralResponse struct {
	arcgisError
	Features []CadastralFeature `json:"features"`
}

// sanitizeWhere neutralizes quoting/statement injection in ArcGIS WHERE literals.
func sanitizeWhere(s string) string {
	s = strings.ReplaceAll(s, "'", "''")
	s = strings.NewReplacer(";", "", "\\", "").Replace(s)
	return strings.TrimSpace(s)
}

// cadastralByQuery matches on AddressLine1 or PARCELID via a LIKE clause.
func (s *Service) cadastralByQuery(ctx context.Context, q string) (*CadastralFeature, error) {
	street := sanitizeWhere(extractStreetAddress(q))
	id := sanitizeWhere(q)
	where := fmt.Sprintf("UPPER(AddressLine1) LIKE UPPER('%%%s%%') OR UPPER(PARCELID) LIKE UPPER('%%%s%%')", street, id)
	return s.cadastralQuery(ctx, url.Values{"where": {where}, "resultRecordCount": {"1"}})
}

// cadastralByPoint runs a point-in-polygon spatial query.
func (s *Service) cadastralByPoint(ctx context.Context, ll LatLng) (*CadastralFeature, error) {
	geom, _ := json.Marshal(map[string]float64{"x": ll.Lng, "y": ll.Lat})
	return s.cadastralQuery(ctx, url.Values{
		"geometry":     {string(geom)},
		"geometryType": {"esriGeometryPoint"},
		"spatialRel":   {"esriSpatialRelIntersects"},
		"inSR":         {"4326"},
		"resultRecordCount": {"1"},
	})
}

// cadastralCandidates returns up to 50 parcels whose address contains road,
// largest acreage first — used for TBD addresses.
func (s *Service) cadastralCandidates(ctx context.Context, road string) ([]CadastralFeature, error) {
	where := fmt.Sprintf("UPPER(AddressLine1) LIKE UPPER('%%%s%%')", sanitizeWhere(road))
	resp, err := s.queryCadastralRaw(ctx, url.Values{
		"where":             {where},
		"resultRecordCount": {"50"},
		"orderByFields":     {"TotalAcres DESC"},
	})
	if err != nil {
		return nil, err
	}
	return resp.Features, nil
}

// cadastralByID fetches a single parcel by exact PARCELID.
func (s *Service) cadastralByID(ctx context.Context, parcelID string) (*CadastralFeature, error) {
	where := fmt.Sprintf("PARCELID = '%s'", sanitizeWhere(parcelID))
	return s.cadastralQuery(ctx, url.Values{"where": {where}, "resultRecordCount": {"1"}})
}

// cadastralQuery runs a query and returns the first feature (or nil).
func (s *Service) cadastralQuery(ctx context.Context, params url.Values) (*CadastralFeature, error) {
	resp, err := s.queryCadastralRaw(ctx, params)
	if err != nil {
		return nil, err
	}
	if len(resp.Features) == 0 {
		return nil, nil
	}
	return &resp.Features[0], nil
}

func (s *Service) queryCadastralRaw(ctx context.Context, params url.Values) (*cadastralResponse, error) {
	params.Set("outFields", cadastralFields)
	params.Set("returnGeometry", "true")
	params.Set("outSR", "4326")
	params.Set("f", "json")

	var resp cadastralResponse
	if err := s.gis.GetJSON(ctx, cadastralURL+"?"+params.Encode(), &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		s.log.Warn("cadastral query error", "message", resp.Error.Message)
		return &cadastralResponse{}, nil // treat as no match, as the TS service did
	}
	return &resp, nil
}

type addressPointResponse struct {
	arcgisError
	Features []struct {
		Attributes struct {
			ParcelID *string `json:"ParcelID"`
		} `json:"attributes"`
	} `json:"features"`
}

// byAddressPoint resolves a street address to a parcel via the MT E911 address
// points layer, then fetches the cadastral record by ID.
func (s *Service) byAddressPoint(ctx context.Context, q string) (*CadastralFeature, error) {
	street := extractStreetAddress(q)
	num, name, ok := parseStreetNumber(street)
	if !ok || num == 0 || name == "" {
		return nil, nil
	}
	var city string
	if parts := strings.Split(q, ","); len(parts) > 1 {
		city = strings.TrimSpace(parts[1])
	}

	where := fmt.Sprintf("Add_Number = %d AND UPPER(St_Name) LIKE UPPER('%%%s%%')", num, sanitizeWhere(name))
	if city != "" {
		where += fmt.Sprintf(" AND UPPER(Post_Comm) LIKE UPPER('%%%s%%')", sanitizeWhere(city))
	}

	params := url.Values{
		"where":             {where},
		"outFields":         {"ParcelID,Add_Number,St_Name,Post_Comm"},
		"resultRecordCount": {"1"},
		"f":                 {"json"},
	}

	var resp addressPointResponse
	if err := s.gis.GetJSON(ctx, msdiAddressURL+"?"+params.Encode(), &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		s.log.Warn("address point lookup error", "message", resp.Error.Message)
		return nil, nil
	}
	if len(resp.Features) == 0 || resp.Features[0].Attributes.ParcelID == nil {
		return nil, nil
	}
	parcelID := *resp.Features[0].Attributes.ParcelID
	s.log.Info("address point matched", "q", q, "parcelID", parcelID)
	return s.cadastralByID(ctx, parcelID)
}

// toCandidates projects cadastral features into lightweight Candidate summaries.
func toCandidates(features []CadastralFeature) []Candidate {
	out := make([]Candidate, 0, len(features))
	for _, f := range features {
		out = append(out, Candidate{
			ParcelID: f.Attributes.ParcelID,
			Address:  formatAddress(f.Attributes),
			Acreage:  acreage(f.Attributes),
			County:   f.Attributes.CountyName,
		})
	}
	return out
}
