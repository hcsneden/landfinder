package parcel

import "testing"

func TestMergeRights_GeocodeWinsOnConflict(t *testing.T) {
	geo := []wrqsFeature{{Attributes: map[string]any{
		"WR_NUMBER": "76H 30012345", "SOURCE_TYPES": "GROUNDWATER", "WR_STATUS": "ACTIVE",
	}}}
	pou := []wrqsFeature{{Attributes: map[string]any{
		"WR_NUMBER": "76H 30012345", "OWNERS": "Jane Doe", "PURPOSE": "IRRIGATION",
	}}}

	got := mergeRights(geo, pou)

	if len(got) != 1 {
		t.Fatalf("len = %d, want 1", len(got))
	}
	if got[0].WaterType != WaterTypeGroundwater {
		t.Errorf("WaterType = %q, want groundwater (geocode layer)", got[0].WaterType)
	}
	if got[0].RawData["source"] != "dnrc_both" {
		t.Errorf("source = %v, want dnrc_both", got[0].RawData["source"])
	}
	if got[0].RawData["owners"] != "Jane Doe" {
		t.Errorf("owners = %v, want Jane Doe (POU metadata)", got[0].RawData["owners"])
	}
}

func TestMergeRights_DisjointRights(t *testing.T) {
	geo := []wrqsFeature{{Attributes: map[string]any{"WR_NUMBER": "A", "WR_STATUS": "ACTIVE"}}}
	pou := []wrqsFeature{{Attributes: map[string]any{"WR_NUMBER": "B", "WR_STATUS": "PENDING"}}}

	got := mergeRights(geo, pou)
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got[0].RawData["source"] != "dnrc_geocode" || got[1].RawData["source"] != "dnrc_place_of_use" {
		t.Errorf("sources = %v / %v", got[0].RawData["source"], got[1].RawData["source"])
	}
}

func TestParseStatus(t *testing.T) {
	tests := map[string]WaterStatus{
		"ACTIVE":     StatusActive,
		"INACTIVE":   StatusInactive,
		"TERMINATED": StatusInactive,
		"PENDING":    StatusPending,
		"":           StatusUnknown,
		"WEIRD":      StatusUnknown,
	}
	for in, want := range tests {
		if got := parseStatus(in); got != want {
			t.Errorf("parseStatus(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseWaterType(t *testing.T) {
	if got := parseWaterType("SURFACE & GROUNDWATER"); got != WaterTypeMixed {
		t.Errorf("got %q, want mixed", got)
	}
	if got := parseWaterType("GROUNDWATER"); got != WaterTypeGroundwater {
		t.Errorf("got %q, want groundwater", got)
	}
	if got := parseWaterType("SURFACE WATER"); got != WaterTypeSurface {
		t.Errorf("got %q, want surface", got)
	}
}

func TestParsePriorityDate(t *testing.T) {
	// 1970-01-02 in epoch millis.
	if got := parsePriorityDate(float64(86_400_000), nil); got == nil || *got != "1970-01-02" {
		t.Errorf("got %v, want 1970-01-02", got)
	}
	if got := parsePriorityDate(nil, "1889-11-08T00:00:00Z"); got == nil || *got != "1889-11-08" {
		t.Errorf("got %v, want 1889-11-08", got)
	}
	if got := parsePriorityDate(nil, nil); got != nil {
		t.Errorf("got %v, want nil", got)
	}
}
