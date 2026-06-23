# LandFinder — Product Requirements Document

**Version:** 0.1 — Draft  
**Status:** In Review  
**Last Updated:** June 2026

---

## 1. Overview

LandFinder is a web application that aggregates land listings from multiple real estate platforms and enriches each listing with authoritative public data — water rights, utility access, environmental conditions, buildability signals, and land history. The goal is to give buyers a complete picture of a parcel before they ever contact a broker, with a particular emphasis on rural and recreational land in Montana where the gaps between listing data and reality are large and consequential.

Users can search by text or by drawing a map area, browse aggregated listings on an interactive map, and drill into a detailed property view that pulls from GIS layers, state agency databases, and configurable remote data sources (S3-hosted config files). A loan calculator gives buyers a quick sense of financing before they pursue a listing further.

---

## 2. Problem Statement

Land buyers — especially buyers new to rural Montana — routinely make offers or lose earnest money because they did not know a parcel had no legal road access, no viable water right, was under a conservation easement that prohibits any building, or sat on top of an old mine adit. This information is publicly available but scattered across a dozen state and federal databases that most buyers do not know exist and cannot navigate efficiently.

Existing listing platforms (LandWatch, Lands of America, Zillow) surface price, acreage, and photos. They do not surface the information that determines whether a parcel is actually usable. LandFinder bridges that gap.

---

## 3. Target Users

**Primary:** Individual land buyers evaluating rural or recreational land in Montana, including out-of-state buyers unfamiliar with Montana-specific regulations and water law.

**Secondary:** Buyer's agents and real estate attorneys who want a fast due diligence starting point for clients. Small investors evaluating multiple parcels at once.

---

## 4. Core Features

### 4.1 Search and Map Interface

**Text search** accepts a city, county, zip code, address, or parcel number and zooms the map to that area.

**Map area search** lets users draw a bounding box or polygon on the map. All listings within the drawn area load into the results panel.

**Listing pins** render on the map canvas with visual differentiation by price range or acreage. Clustering applies at low zoom levels and breaks into individual pins as the user zooms in.

**Filters** are available for: price range, acreage range, listing source, water right present (yes/no/unknown), grid power access (yes/no/unknown), road access type, conservation easement status, and flood zone status.

**Results panel** shows a scrollable list of listings alongside the map. Hovering a listing highlights its pin and vice versa.

### 4.2 Property Detail View

Clicking a listing pin or result card opens a full-screen detail panel. This panel is organized into the sections below.

#### 4.2.1 Listing Summary
- Price and price per acre
- Acreage
- Parcel ID and county
- Listing source and original listing link
- Days on market
- Broker/agent contact info

#### 4.2.2 Water Rights
This is the single most important category for Montana land and deserves prominent placement.

- Water right certificates on file with Montana DNRC (pulled from the Water Right Query System)
- Priority date for each right (earlier = more senior = more secure)
- Decreed use type: irrigation, domestic, livestock, municipal, etc.
- Flow rate or volume (CFS, acre-feet/year, gallons per minute)
- Point of diversion and source (surface stream, spring, well)
- Status: active, abandoned, unadjudicated
- Well log records from the Montana Bureau of Mines and Geology (MBMG), including drilled depth, static water level, and yield (GPM)
- Warning badge if no water right is on file for the parcel — buyers should be explicitly told this is a risk, not an oversight

#### 4.2.3 Road and Legal Access
- Access type: public county road, deeded private road, easement, BLM or Forest Service road
- Landlocked flag — if no documented legal access exists, surface this prominently as a critical issue
- Year-round vs seasonal access (many roads in rural Montana are impassable November through April)
- Nearest paved road (miles)
- Road surface type where known

#### 4.2.4 Utility and Grid Access
- Electric: grid-connected, distance to nearest power line, or off-grid only
- Natural gas vs propane territory
- Broadband and cell coverage: carrier coverage map data per parcel centroid, noted as approximate
- Septic: existing permitted system on record, perc test history, or no documented system
- Municipal water and sewer: connection available or not

#### 4.2.5 Dwelling and Structures
- Any existing structures on record with county assessor
- Building permit history from county records
- Year built, square footage, condition class (as reported by assessor)
- Septic permit records tied to existing dwelling

#### 4.2.6 Buildability Assessment
The app synthesizes multiple data signals to produce a buildability summary rather than a single score, since buildability depends heavily on buyer intent.

Signals used:
- **Zoning / land use designation** — many Montana counties have no zoning; those that do are noted. Ag exemptions and agricultural land classification are flagged.
- **Conservation easement** — pulled from county records and NRCS Farm Service Agency data. If an easement is present, the restriction type and holder are displayed. This is a hard development blocker in many cases.
- **Flood zone** — FEMA National Flood Hazard Layer, displayed with zone designation (AE, X, etc.)
- **Wetlands** — National Wetlands Inventory overlay, footprint area within the parcel
- **Slope analysis** — derived from USGS elevation data. Parcels with median slope above 20% are flagged as potentially difficult to build on.
- **Soil type** — NRCS SSURGO data, with a note on whether soils are rated as suitable for on-site septic (perc-capable)
- **Subdivision covenants / CC&Rs** — surfaced if available in county document records; otherwise noted as unknown

The buildability summary reads as a brief narrative (e.g., "Parcel is partially in an AE flood zone and contains wetlands along the eastern boundary. No conservation easement on record. County has no zoning. Soils are moderately well-drained and may support on-site septic pending a perc test.") rather than a score.

#### 4.2.7 Environmental and Risk Flags
- **Wildfire risk** — fire risk class from USFS data and historical fire perimeters (MTBS) intersecting the parcel
- **Proximity to EPA Superfund sites** — Montana has several active NPL sites (Clark Fork, Libby, Rocker/Opportunity). Any site within a configurable radius is surfaced.
- **Mining history** — Montana DEQ mine permit records and MBMG abandoned mine database. Old adits, shafts, and tailings on or adjacent to a parcel are flagged.
- **Proximity to public land** — adjacent BLM, USFS, and MT State land is noted (often a positive, but matters for access and fire risk context)

#### 4.2.8 Land History
- **Ownership chain** — county deed/title transfer dates and prior owners from county recorder records where accessible
- **Agricultural use** — USDA FSA crop history for the parcel (last 5 years where available), including irrigated vs dryland crop reporting
- **Grazing leases** — whether the parcel is subject to an active or recently expired grazing lease
- **Timber harvest history** — USFS harvest records for parcels in or adjacent to forested areas
- **Fire history** — MTBS-derived fire perimeter intersection, with burn year and severity

#### 4.2.9 Financial Tools

**Monthly payment estimator**
- Input: purchase price (pre-filled), down payment (percent or dollar), interest rate, loan term
- Output: estimated monthly principal and interest
- Note displayed that land loans typically carry higher rates and shorter terms than residential mortgages, with a prompt to consult a lender

**Comparable sales**
- Recent sold parcels within the county or a configurable radius, sorted by sale date
- Price per acre comparison against the current listing

**Property tax history**
- Assessed value history from county records
- Current annual tax bill
- Agricultural tax exemption status if applicable (ag-exempt land is taxed at a significantly lower rate in Montana)

### 4.3 Map Overlays

Users can toggle GIS layers on and off from a layers panel. Available layers:

- Parcel boundaries (Montana Cadastral)
- County boundaries
- USFS and National Forest boundaries
- BLM land
- MT State land
- Flood zones (FEMA)
- Wetlands (NWI)
- Wildfire history (MTBS perimeters)
- Soils (SSURGO)
- Water features (NHD)
- County roads
- Power line corridors
- Cell coverage (approximate)

Layer configuration — including source URLs, styling, and visibility defaults — is loaded from a config file at application startup. This config lives in S3 and can be updated without a code deployment. This allows layer sources to be swapped, added, or removed as upstream data providers change.

---

## 5. Data Sources

| Category | Source | Access Method |
|---|---|---|
| Parcel boundaries and ownership | Montana Cadastral (NRIS) | Public REST/WFS |
| Water rights | Montana DNRC WRQS | Public API / scrape |
| Well logs | Montana MBMG Groundwater Database | Public API |
| Mine records | Montana DEQ / MBMG Abandoned Mines | Public datasets |
| Soils | USDA NRCS SSURGO | REST |
| Flood zones | FEMA National Flood Hazard Layer | REST |
| Wetlands | USFWS National Wetlands Inventory | REST |
| Wildfire perimeters | USFS MTBS | GeoJSON download, S3-cached |
| Elevation / slope | USGS 3DEP | REST |
| Public land boundaries | BLM / USFS | REST |
| Agricultural crop history | USDA FSA CropScape | REST |
| County assessor records | County-level GIS portals (varies by county) | Scrape or API where available |
| Superfund sites | EPA ECHO / FRS | REST |
| Cell coverage | FCC Broadband Map | REST |
| Land listings | LandWatch, Lands of America, LandAndFarm, Zillow, Realtor.com, county MLS | API or scrape per source |

---

## 6. Technical Architecture (High Level)

### 6.1 Frontend
React SPA. Map rendered with Mapbox GL JS or MapLibre GL JS. Detail panel opens as a side sheet or modal without a full page navigation.

### 6.2 Listing Aggregation Service
A backend service that pulls listings from each configured source on a scheduled interval, normalizes them to a common schema, deduplicates by parcel ID or lat/lng proximity, and stores them in a database. Each listing record retains source attribution and a link to the original.

### 6.3 Property Enrichment Service
When a listing is indexed (or on-demand when a user opens a detail view), the enrichment service queries each public data source for the parcel and caches the results. Heavy GIS intersections (flood zone, wetlands, slope) run at indexing time. Real-time queries are reserved for high-freshness data like water right status.

### 6.4 GIS Layer Config (S3)
A JSON config file in S3 defines each map overlay layer: source type (WMS, WFS, TileJSON, GeoJSON), source URL, authentication if needed, default visibility, display name, and styling. The frontend loads this config at startup. Updating a layer requires only a config file push, not a code change.

Example config structure:

```json
{
  "layers": [
    {
      "id": "flood-zones",
      "name": "FEMA Flood Zones",
      "type": "wms",
      "url": "https://hazards.fema.gov/gis/nfhl/services/public/NFHL/MapServer/WMSServer",
      "defaultVisible": false,
      "category": "environmental"
    }
  ]
}
```

### 6.5 Caching Strategy
GIS data changes infrequently. Most enrichment data is cached at the property level with a TTL appropriate to its update frequency (soil data: 1 year, water right status: 1 week, listing data: daily). S3 or a Redis-compatible cache can serve cached GIS responses.

---

## 7. Montana-Specific Considerations

Montana has a number of legal and physical characteristics that distinguish it from other land markets and must be accounted for explicitly in the product rather than treated as edge cases.

**Prior appropriation water law.** Montana uses the "first in time, first in right" doctrine. A parcel with a junior water right may legally receive no water in a dry year. The priority date of a water right matters as much as the volume. The product must display priority dates and flag unadjudicated rights, which are common on older agricultural parcels.

**Landlocked parcels.** Landlocked land (no legal surface access) exists and is actively listed for sale. This is a legitimate purchase scenario (hunting, mineral access) but it is also a trap for uninformed buyers. A prominent landlocked warning should appear whenever no deeded or easement road access can be confirmed.

**Conservation easements.** Montana has one of the highest concentrations of conservation easements in the country, driven by the Montana Land Reliance and various land trusts. An easement may prohibit subdivision, commercial use, or any new construction. Easement presence and type must be surfaced clearly, not buried in a details section.

**Minimal county zoning.** Many Montana counties (Beaverhead, Granite, Petroleum, etc.) have no countywide zoning. This is a selling point for some buyers and a red flag for others. The absence of zoning should be stated explicitly rather than showing a blank zoning field.

**Mining legacy.** Montana has a significant legacy of hard rock and placer mining. Old mine workings — including adits, shafts, and waste rock piles — can be physically dangerous and may trigger environmental liability. The product should flag known mine features on or within a buffer of the parcel.

**Seasonal access.** Roads that are passable in July may be completely inaccessible November through April. Road access should include a seasonal note where road type suggests this is a risk (e.g., unimproved two-track, USFS roads with seasonal closures).

**Agricultural tax exemption.** Montana taxes agricultural land at a fraction of its market value when it qualifies for ag exemption. Buyers who intend to convert ag land to recreational or residential use should understand that their tax bill may increase substantially. Current tax figures should include an ag exemption flag.

---

## 8. Non-Functional Requirements

**Performance.** Map tiles and parcel boundaries should render within 2 seconds at any zoom level. Property detail data should load within 3 seconds for cached results. Uncached enrichment requests (first time a parcel is viewed) may take up to 10 seconds with a loading state displayed.

**Data freshness.** Listing data should be no more than 24 hours stale. Water right data should refresh weekly. All GIS enrichment data should display its source date so users know how current it is.

**Data accuracy disclaimer.** Every data point sourced from a public agency should include attribution and a note that the app does not guarantee accuracy. Users should be directed to verify critical information (especially water rights and access) through county records and a real estate attorney before closing.

**Mobile responsiveness.** The map and detail view should be usable on a phone, though the primary use case is desktop or tablet.

**Accessibility.** Color-coded map overlays must include a legend and must not rely on color alone to convey meaning. Detail panel text must meet WCAG AA contrast ratios.

---

## 9. Out of Scope for V1

- Offering or transaction support (this is a research tool, not a buying platform)
- Montana mineral rights data (complex and deserves its own treatment)
- Aerial or satellite imagery beyond what the base map provider supplies
- Montana-specific water court and adjudication proceedings (DNRC status surfaced, but not full adjudication documents)
- Automated perc test or buildability certification (the app surfaces signals, not a legal determination)
- User accounts and saved searches (V2)
- Email or SMS alerts for new listings matching saved criteria (V2)

---

## 10. Open Questions

- Which listing sources permit aggregation under their terms of service, and which require licensing or partnership agreements?
- Will county assessor data be accessible programmatically for all target Montana counties, or will some require manual data requests?
- Should the GIS layer config support per-county overrides (e.g., some counties have better GIS data than others)?
- Is the loan calculator sufficient for V1, or do users need a full amortization table and early payoff modeling?
- What is the right UX for handling parcels where enrichment data is partially unavailable — show partial data or block the detail view until complete?
