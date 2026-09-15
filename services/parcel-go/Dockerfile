# Build a static binary, then ship it on a minimal runtime image.
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/parcel ./cmd/parcel

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/parcel /parcel
EXPOSE 8080
ENTRYPOINT ["/parcel"]
