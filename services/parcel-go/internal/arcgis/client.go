// Package arcgis provides a small HTTP client for ArcGIS REST "query" endpoints
// and other government GIS services used by the parcel lookup pipeline.
package arcgis

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// DefaultTimeout matches the 25s budget the original TypeScript service allowed
// for slow Montana state GIS servers.
const DefaultTimeout = 25 * time.Second

// Client issues GET requests against GIS endpoints and decodes JSON responses.
type Client struct {
	http      *http.Client
	userAgent string
}

// New returns a Client with the default timeout. contactEmail goes in the
// User-Agent, which Nominatim's usage policy requires.
func New(contactEmail string) *Client {
	return &Client{
		http:      &http.Client{Timeout: DefaultTimeout},
		userAgent: fmt.Sprintf("landfinder/1.0 (%s)", contactEmail),
	}
}

// NewWithClient lets tests inject an *http.Client pointed at an httptest.Server.
func NewWithClient(c *http.Client) *Client { return &Client{http: c, userAgent: "landfinder/test"} }

// GetJSON issues a GET to rawURL and decodes the response body into v.
// The provided context bounds the request; a deadline there overrides the
// client timeout.
func (c *Client) GetJSON(ctx context.Context, rawURL string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("User-Agent", c.userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("gis request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("gis request: unexpected status %d", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return fmt.Errorf("decode gis response: %w", err)
	}
	return nil
}
