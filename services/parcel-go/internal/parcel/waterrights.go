package parcel

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	wrqsGeocodeURL = "https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query"
	wrqsPOUURL     = "https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/2/query"

	wrqsGeocodeFields = "WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,SOURCE_NAMES,SOURCE_TYPES,MAX_FLOW_GPM,MAX_VOL,GEOCD"
	wrqsPOUFields     = "WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,ENF_PRTY_DT_CHAR,OWNERS,PURPOSE,MAX_FLOW_GPM,MAX_FLOW_CFS,MAX_VOL,GEOCODES,URL_ABSTRACT"
)

type wrqsFeature struct {
	Attributes map[string]any `json:"attributes"`
}

type wrqsResponse struct {
	arcgisError
	Features []wrqsFeature `json:"features"`
}

// SeedWaterRights fetches the DNRC geocode and place-of-use layers concurrently,
// merges them, and upserts the result. Failures are returned but treated as
// non-fatal by the caller.
func (s *Service) SeedWaterRights(ctx context.Context, parcelID, geocode string, rings [][][]float64, c LatLng, hasCentroid bool) error {
	var (
		geoFeats, pouFeats []wrqsFeature
		geoErr, pouErr     error
		wg                 sync.WaitGroup
	)
	wg.Add(2)
	go func() { defer wg.Done(); geoFeats, geoErr = s.wrqsGeocodes(ctx, geocode) }()
	go func() { defer wg.Done(); pouFeats, pouErr = s.wrqsPlaceOfUse(ctx, rings, c, hasCentroid) }()
	wg.Wait()
	// Either source failing is tolerable; surface the first error for logging only.
	if geoErr != nil {
		return geoErr
	}
	if pouErr != nil {
		return pouErr
	}

	s.log.Info("wrqs results", "parcelID", parcelID, "geocode", len(geoFeats), "pou", len(pouFeats))
	merged := mergeRights(geoFeats, pouFeats)
	if len(merged) == 0 {
		return nil
	}
	return s.store.UpsertWaterRights(ctx, parcelID, merged)
}

func (s *Service) wrqsGeocodes(ctx context.Context, geocode string) ([]wrqsFeature, error) {
	params := url.Values{
		"where":             {"GEOCD = '" + sanitizeWhere(geocode) + "'"},
		"outFields":         {wrqsGeocodeFields},
		"resultRecordCount": {"100"},
		"f":                 {"json"},
	}
	var resp wrqsResponse
	if err := s.gis.GetJSON(ctx, wrqsGeocodeURL+"?"+params.Encode(), &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		s.log.Warn("wrqs geocode error", "message", resp.Error.Message)
		return nil, nil
	}
	return resp.Features, nil
}

func (s *Service) wrqsPlaceOfUse(ctx context.Context, rings [][][]float64, c LatLng, hasCentroid bool) ([]wrqsFeature, error) {
	params := url.Values{
		"spatialRel":        {"esriSpatialRelIntersects"},
		"inSR":              {"4326"},
		"where":             {"1=1"},
		"outFields":         {wrqsPOUFields},
		"resultRecordCount": {"100"},
		"f":                 {"json"},
	}
	switch {
	case len(rings) > 0:
		geom, _ := json.Marshal(map[string]any{"rings": rings})
		params.Set("geometry", string(geom))
		params.Set("geometryType", "esriGeometryPolygon")
	case hasCentroid:
		geom, _ := json.Marshal(map[string]float64{"x": c.Lng, "y": c.Lat})
		params.Set("geometry", string(geom))
		params.Set("geometryType", "esriGeometryPoint")
		// Small radius so a point-only parcel doesn't grab neighbors.
		params.Set("distance", "0.1")
		params.Set("units", "esriSRUnit_StatuteMile")
	default:
		return nil, nil
	}

	var resp wrqsResponse
	if err := s.gis.GetJSON(ctx, wrqsPOUURL+"?"+params.Encode(), &resp); err != nil {
		return nil, err
	}
	if resp.Error != nil {
		s.log.Warn("wrqs place-of-use error", "message", resp.Error.Message)
		return nil, nil
	}
	return resp.Features, nil
}

// mergeRights reconciles the two layers keyed by WR_NUMBER. The geocode layer
// carries source name/type and wins on conflict; the place-of-use layer
// contributes owner/purpose metadata.
func mergeRights(geocodeFeatures, pouFeatures []wrqsFeature) []MergedRight {
	byNumber := make(map[string]*MergedRight)
	order := make([]string, 0, len(geocodeFeatures)+len(pouFeatures))

	for _, f := range geocodeFeatures {
		wr := str(f.Attributes["WR_NUMBER"])
		if wr == "" {
			continue
		}
		if _, seen := byNumber[wr]; !seen {
			order = append(order, wr)
		}
		byNumber[wr] = fromGeocodeFeature(f.Attributes)
	}

	for _, f := range pouFeatures {
		wr := str(f.Attributes["WR_NUMBER"])
		if wr == "" {
			continue
		}
		if existing, ok := byNumber[wr]; ok {
			existing.RawData["source"] = "dnrc_both"
			existing.RawData["owners"] = f.Attributes["OWNERS"]
			existing.RawData["purpose"] = f.Attributes["PURPOSE"]
			existing.RawData["abstractUrl"] = f.Attributes["URL_ABSTRACT"]
			existing.RawData["geocodes"] = f.Attributes["GEOCODES"]
			continue
		}
		order = append(order, wr)
		byNumber[wr] = fromPOUFeature(f.Attributes)
	}

	out := make([]MergedRight, 0, len(order))
	for _, wr := range order {
		out = append(out, *byNumber[wr])
	}
	return out
}

func fromGeocodeFeature(attr map[string]any) *MergedRight {
	return &MergedRight{
		WRNumber:     str(attr["WR_NUMBER"]),
		WaterSource:  strPtr(attr["SOURCE_NAMES"]),
		WaterType:    parseWaterType(attr["SOURCE_TYPES"]),
		FlowRateGPM:  floatPtr(attr["MAX_FLOW_GPM"]),
		Volume:       floatPtr(attr["MAX_VOL"]),
		PriorityDate: parsePriorityDate(attr["ENF_PRTY_DT_DATE"], nil),
		Status:       parseStatus(attr["WR_STATUS"]),
		RawData: map[string]any{
			"source":    "dnrc_geocode",
			"fetchedAt": time.Now().UTC().Format(time.RFC3339),
			"geocd":     attr["GEOCD"],
		},
	}
}

func fromPOUFeature(attr map[string]any) *MergedRight {
	return &MergedRight{
		WRNumber:     str(attr["WR_NUMBER"]),
		WaterSource:  nil, // source name lives on the Point-of-Diversion layer
		WaterType:    WaterTypeSurface,
		FlowRateGPM:  floatPtr(attr["MAX_FLOW_GPM"]),
		Volume:       floatPtr(attr["MAX_VOL"]),
		PriorityDate: parsePriorityDate(attr["ENF_PRTY_DT_DATE"], attr["ENF_PRTY_DT_CHAR"]),
		Status:       parseStatus(attr["WR_STATUS"]),
		RawData: map[string]any{
			"source":      "dnrc_place_of_use",
			"fetchedAt":   time.Now().UTC().Format(time.RFC3339),
			"owners":      attr["OWNERS"],
			"purpose":     attr["PURPOSE"],
			"abstractUrl": attr["URL_ABSTRACT"],
			"geocodes":    attr["GEOCODES"],
		},
	}
}

func parseStatus(raw any) WaterStatus {
	s := strings.ToUpper(str(raw))
	switch {
	case strings.Contains(s, "ACTIVE") && !strings.Contains(s, "IN"):
		return StatusActive
	case strings.Contains(s, "INACTIVE"), strings.Contains(s, "TERMINATED"),
		strings.Contains(s, "ABANDONED"), strings.Contains(s, "REVOKED"):
		return StatusInactive
	case strings.Contains(s, "PENDING"), strings.Contains(s, "APPLICATION"):
		return StatusPending
	default:
		return StatusUnknown
	}
}

func parseWaterType(raw any) WaterType {
	s := strings.ToUpper(str(raw))
	switch {
	case strings.Contains(s, "SURFACE") && strings.Contains(s, "GROUND"):
		return WaterTypeMixed
	case strings.Contains(s, "GROUND"):
		return WaterTypeGroundwater
	default:
		return WaterTypeSurface
	}
}

// parsePriorityDate accepts ArcGIS epoch-millis or a fallback date string and
// returns YYYY-MM-DD.
func parsePriorityDate(epochMs, fallback any) *string {
	if ms, ok := epochMs.(float64); ok {
		d := time.UnixMilli(int64(ms)).UTC().Format("2006-01-02")
		return &d
	}
	if s, ok := fallback.(string); ok && s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			d := t.Format("2006-01-02")
			return &d
		}
	}
	return nil
}

// --- small any-coercion helpers (ArcGIS returns loosely-typed JSON) ---

func str(v any) string {
	s, _ := v.(string)
	return s
}

func strPtr(v any) *string {
	if s, ok := v.(string); ok && s != "" {
		return &s
	}
	return nil
}

func floatPtr(v any) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}
