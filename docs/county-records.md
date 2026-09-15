# Montana County Records — Recorder & Treasurer Data Access

Reference for prioritizing county-level integrations (deeds, recorded easements,
mineral severance, tax status/delinquency). Statewide assessor-level data we
already get from **MT Cadastral** (DNRC ArcGIS) — this doc is about the records
that live at the *county* level and aren't in the cadastral feed.

> ⚠ URLs below need per-county confirmation before wiring a scraper. They change
> and several sit behind subscription/CAPTCHA gates. The **platform** column is
> the durable, actionable part — see "Scrape by platform, not by county."

## Why this matters (what these records add)

| Record | Office | Fills the gap on |
|---|---|---|
| Deeds / grantor-grantee | Clerk & Recorder | Ownership history, **mineral severance** (split estate) |
| Recorded easements / ROW | Clerk & Recorder | **Legal access** — complements our TIGER/BLM/USFS heuristic |
| Certificate of Survey (COS) / plats | Clerk & Recorder | True boundaries, easements, subdivision lineage |
| Covenants / CC&Rs | Clerk & Recorder | Use restrictions |
| Tax status & **delinquency** | Treasurer | Carrying cost, liens, **tax-sale opportunities** |
| Improvement detail (year built, condition) | Assessor / DOR ORION | Building value breakdown cadastral omits |

## Scrape by platform, not by county

MT's 56 counties concentrate onto a few vendor systems. Write one adapter per
platform and you cover many counties at once. This is the prioritization lever.

**Recording / grantor-grantee search platforms (typical in MT):**
- **Fidlar — Laredo / Tapestry** (subscription; Tapestry is pay-per-search, Laredo is subscription). Common across MT recorders.
- **Cott Systems — eAccess / county records**.
- **Kofile / US Land Records**.
- A few large counties run their own portal (see Tier 1).

**Treasurer / tax-payment & lookup platforms:**
- **MontanaPayIt / PayIt** (state-affiliated, several counties).
- **Point & Pay**, **BS&A**, **iTax**, **GovTech Tax** — county tax lookup/pay.
- Big counties run their own "property tax inquiry" pages.

**Action:** confirm which platform each Tier-1/2 county uses, then build 3-4
adapters (Fidlar, Cott, PayIt, plus per-county for the self-hosted big ones)
instead of 56 one-offs.

## Priority tiers (by land-market volume + data accessibility)

### Tier 1 — target first (high transaction volume, own modern portals, mostly online)
These are where the buyer profile (recreational/ag/ranch/exurban) concentrates
and where online access is best.

| County | Seat | GIS/Assessor | Recorder online? | Treasurer/tax online? |
|---|---|---|---|---|
| Gallatin | Bozeman | Own GIS portal | Yes (own + vendor) | Yes |
| Flathead | Kalispell | Own GIS portal | Yes | Yes |
| Missoula | Missoula | Own GIS portal | Yes | Yes |
| Yellowstone | Billings | Own GIS portal | Yes | Yes |
| Ravalli | Hamilton | Own GIS | Partial (vendor) | Yes |
| Lewis & Clark | Helena | Own GIS | Vendor | Yes |
| Cascade | Great Falls | Own GIS | Vendor | Yes |

### Tier 2 — high land value, smaller/rural, often vendor-hosted
Prime recreational/ranch land; recorder search usually via Fidlar/Cott, tax via PayIt/vendor.

Park, Madison, Beaverhead, Powell, Sanders, Lincoln, Carbon, Stillwater,
Sweet Grass, Jefferson, Broadwater, Granite, Lake, Meagher.

- Expect: cadastral covers parcels/values; **recorder = subscription vendor**;
  tax lookup varies (many on PayIt/Point&Pay).

### Tier 3 — large-acreage eastern/plains ranch counties, thin online presence
High acreage, low transaction count; recorder often **in-person / phone only**,
tax sometimes online via vendor. Prioritize only if a listing lands there.

Fergus, Custer, Rosebud, Big Horn, Phillips, Valley, Dawson, Richland,
Garfield, Petroleum, McCone, Prairie, Wibaux, Carter, Powder River, etc.

## Recommended build order

1. **Tax delinquency + status** for Tier 1 counties — highest signal (opportunities +
   carrying cost), and the big counties expose it most cleanly. Start with whichever
   Tier-1 counties are on **PayIt** (one adapter → several counties).
2. **Recorded easements + mineral severance** via the **Fidlar** adapter (Tapestry
   pay-per-search is scriptable per parcel) — covers many Tier 1/2 recorders at once.
3. **County GIS improvement detail** only where cadastral is thin — Tier 1 self-hosted
   portals expose ORION-style building detail.

## Open questions to resolve per county before coding
- Exact recording-search platform + whether it allows programmatic/subscription API
  vs. CAPTCHA-gated UI (determines scrape vs. licensed data feed).
- Whether tax lookup returns delinquency status in the response or only current bill.
- Terms of use / rate limits — several vendors prohibit scraping; a licensed feed
  (e.g., title-data vendor) may be cheaper than fighting per-county portals.
