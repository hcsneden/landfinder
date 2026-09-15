package parcel

import "testing"

func TestCentroid(t *testing.T) {
	// A unit square centered at (0.5, 0.5) in lng/lat, plus the closing vertex.
	rings := [][][]float64{{{0, 0}, {1, 0}, {1, 1}, {0, 1}, {0, 0}}}
	got, ok := Centroid(rings)
	if !ok {
		t.Fatal("expected centroid")
	}
	if got.Lng < 0.39 || got.Lng > 0.41 || got.Lat < 0.39 || got.Lat > 0.41 {
		t.Errorf("centroid = %+v, want ~{0.4, 0.4}", got)
	}

	if _, ok := Centroid(nil); ok {
		t.Error("expected no centroid for nil rings")
	}
}

func TestParseStreetNumber(t *testing.T) {
	tests := []struct {
		in       string
		wantNum  int
		wantName string
		wantOK   bool
	}{
		{"123 Main St", 123, "Main", true},
		{"45 Arcturus Drive", 45, "Arcturus", true},
		{"7 County Road", 7, "County", true},
		{"Main St", 0, "Main St", false},
	}
	for _, tt := range tests {
		num, name, ok := parseStreetNumber(tt.in)
		if num != tt.wantNum || name != tt.wantName || ok != tt.wantOK {
			t.Errorf("parseStreetNumber(%q) = (%d, %q, %v), want (%d, %q, %v)",
				tt.in, num, name, ok, tt.wantNum, tt.wantName, tt.wantOK)
		}
	}
}

func TestTBDHelpers(t *testing.T) {
	if !isTBDAddress("TBD Arcturus Dr, Emigrant, MT") {
		t.Error("expected TBD address to be detected")
	}
	if !isTBDAddress("0 Foo Rd") {
		t.Error("expected 0-prefixed address to be detected")
	}
	if isTBDAddress("123 Main St") {
		t.Error("did not expect numbered address to be TBD")
	}
	if got := extractRoadName("Tbd Arcturus Dr, Emigrant, MT 59027"); got != "Arcturus Dr" {
		t.Errorf("extractRoadName = %q, want %q", got, "Arcturus Dr")
	}
}

func TestParseAddressParts(t *testing.T) {
	p, ok := parseAddressParts("123 Main St, Bozeman, MT 59715")
	if !ok {
		t.Fatal("expected parse to succeed")
	}
	if p.Street != "123 Main St" || p.City != "Bozeman" || p.State != "MT" || p.Zip != "59715" {
		t.Errorf("parsed = %+v", p)
	}
	if _, ok := parseAddressParts("no commas here"); ok {
		t.Error("expected failure on malformed address")
	}
}
