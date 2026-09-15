// Package arcgis provides a small HTTP client for ArcGIS REST "query" endpoints
// and other government GIS services used by the parcel lookup pipeline.
package arcgis

import (
	"context"
	"crypto/tls"
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
	http *http.Client
}

// New returns a Client configured for the quirks of Montana state GIS servers,
// which present intermediate CAs not in the default trust bundle. This mirrors
// the `rejectUnauthorized: false` agent in the original Node implementation.
func New() *Client {
	return &Client{
		http: &http.Client{
			Timeout: DefaultTimeout,
			Transport: &http.Transport{
				// #nosec G402 -- documented gap: MT GIS hosts use intermediate CAs
				// absent from the system bundle; pinning would be the production fix.
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
}

// NewWithClient lets tests inject an *http.Client pointed at an httptest.Server.
func NewWithClient(c *http.Client) *Client { return &Client{http: c} }

// GetJSON issues a GET to rawURL and decodes the response body into v.
// The provided context bounds the request; a deadline there overrides the
// client timeout.
func (c *Client) GetJSON(ctx context.Context, rawURL string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	// Nominatim and some ArcGIS hosts reject requests without a User-Agent.
	req.Header.Set("User-Agent", "landfinder/1.0 (hcsneden@gmail.com)")

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
