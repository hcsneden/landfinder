package parcel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// Handler returns an http.Handler for GET /parcels/lookup?q=...
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /parcels/lookup", s.handleLookup)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func (s *Service) handleLookup(w http.ResponseWriter, r *http.Request) {
	result, err := s.Lookup(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		s.writeError(w, r.Context(), err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Service) writeError(w http.ResponseWriter, ctx context.Context, err error) {
	switch {
	case errors.Is(err, ErrBadRequest):
		writeJSON(w, http.StatusBadRequest, errBody("BAD_REQUEST", err.Error()))
	case errors.Is(err, ErrNotFound):
		// The TS service returned 200 with a null body for "no match".
		writeJSON(w, http.StatusOK, (*LookupResult)(nil))
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, ErrTimeout):
		s.log.Warn("lookup timed out")
		writeJSON(w, http.StatusServiceUnavailable,
			errBody("SERVICE_UNAVAILABLE", "The parcel lookup service is temporarily slow. Please try again."))
	default:
		s.log.Error("parcel lookup error", "err", err)
		writeJSON(w, http.StatusInternalServerError,
			errBody("INTERNAL_ERROR", "An error occurred during parcel lookup"))
	}
}

func errBody(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
