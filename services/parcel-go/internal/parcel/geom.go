package parcel

import (
	"regexp"
	"strconv"
	"strings"
)

// Centroid returns the area-weighted centroid of the outer ring using the
// shoelace formula. The bool is false when the ring has fewer than three
// vertices or zero area.
func Centroid(rings [][][]float64) (LatLng, bool) {
	if len(rings) == 0 || len(rings[0]) < 3 {
		return LatLng{}, false
	}
	ring := rings[0]
	var area, cx, cy float64
	for i := range ring {
		p, q := ring[i], ring[(i+1)%len(ring)]
		if len(p) < 2 || len(q) < 2 {
			return LatLng{}, false
		}
		cross := p[0]*q[1] - q[0]*p[1]
		area += cross
		cx += (p[0] + q[0]) * cross
		cy += (p[1] + q[1]) * cross
	}
	if area == 0 {
		return LatLng{}, false
	}
	area /= 2
	return LatLng{Lng: cx / (6 * area), Lat: cy / (6 * area)}, true
}

// extractStreetAddress returns the portion before the first comma.
func extractStreetAddress(q string) string {
	if i := strings.IndexByte(q, ','); i >= 0 {
		return strings.TrimSpace(q[:i])
	}
	return strings.TrimSpace(q)
}

var tbdPrefix = regexp.MustCompile(`(?i)^\s*(tbd|0)\s+`)

// isTBDAddress reports whether q begins with "TBD" or "0" — i.e. no house number.
func isTBDAddress(q string) bool { return tbdPrefix.MatchString(q) }

// extractRoadName strips a TBD/0 prefix and returns the road portion, or "".
func extractRoadName(q string) string {
	withoutPrefix := strings.TrimSpace(tbdPrefix.ReplaceAllString(q, ""))
	road := withoutPrefix
	if i := strings.IndexByte(withoutPrefix, ','); i >= 0 {
		road = strings.TrimSpace(withoutPrefix[:i])
	}
	if len(road) < 3 {
		return ""
	}
	return road
}

var (
	streetNumRe    = regexp.MustCompile(`^(\d+)\s+(.+)`)
	streetSuffixRe = regexp.MustCompile(`(?i)\s+(rd|road|st|street|ave|avenue|ln|lane|dr|drive|way|blvd|ct|court|pl|place|hwy|highway|loop|trl|trail|run|cir|circle|pike|row)\.?$`)
)

// parseStreetNumber splits "123 Main St" into (123, "Main"), stripping the
// trailing street-type suffix so it matches MT address points stored without one.
func parseStreetNumber(street string) (num int, name string, ok bool) {
	m := streetNumRe.FindStringSubmatch(street)
	if m == nil {
		return 0, street, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, street, false
	}
	name = strings.TrimSpace(streetSuffixRe.ReplaceAllString(m[2], ""))
	return n, name, true
}

// addressParts is a structured US address.
type addressParts struct {
	Street, City, State, Zip string
}

var stateZipRe = regexp.MustCompile(`^([A-Za-z]{2})\s*(\d{5})?`)

// parseAddressParts splits "123 Main St, City, ST 12345" into components.
func parseAddressParts(q string) (addressParts, bool) {
	parts := strings.Split(q, ",")
	if len(parts) < 3 {
		return addressParts{}, false
	}
	street := strings.TrimSpace(parts[0])
	city := strings.TrimSpace(parts[1])
	m := stateZipRe.FindStringSubmatch(strings.TrimSpace(parts[2]))
	if m == nil || street == "" || city == "" {
		return addressParts{}, false
	}
	return addressParts{Street: street, City: city, State: m[1], Zip: m[2]}, true
}

// formatAddress joins AddressLine1 and CityStateZip the way the original service did.
func formatAddress(a CadastralAttributes) *string {
	if a.AddressLine1 == nil {
		return nil
	}
	s := strings.TrimSpace(*a.AddressLine1)
	if a.CityStateZip != nil && strings.TrimSpace(*a.CityStateZip) != "" {
		s += ", " + strings.TrimSpace(*a.CityStateZip)
	}
	return &s
}

// acreage prefers TotalAcres, falling back to GISAcres.
func acreage(a CadastralAttributes) *float64 {
	if a.TotalAcres != nil {
		return a.TotalAcres
	}
	return a.GISAcres
}
