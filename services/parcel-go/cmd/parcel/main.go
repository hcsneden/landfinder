// Command parcel runs the parcel-lookup HTTP service.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hsneden/landfinder/parcel-go/internal/arcgis"
	"github.com/hsneden/landfinder/parcel-go/internal/parcel"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Error("DATABASE_URL is required")
		os.Exit(1)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Error("connect to postgres", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	gis := arcgis.New()
	svc := parcel.New(gis, parcel.NewGeocoder(gis, log), parcel.NewPostgresStore(pool), log)

	addr := ":" + cmp(os.Getenv("PORT"), "8080")
	srv := &http.Server{
		Addr:              addr,
		Handler:           svc.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Info("parcel service listening", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server exited", "err", err)
		os.Exit(1)
	}
}

func cmp(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}
