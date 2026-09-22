import { MONTANA_COUNTIES } from '@lastbestland/shared';
import { execute, closePool } from '../shared/db';
import { fetchJson, sleep } from '../shared/http';
import { runScraper, writeRunSummary } from '../shared/runSummary';

// Montana State Library cadastral parcels, the same layer the API's lookup
// uses. PARCELID is the state geocode.
const CADASTRAL_URL = 'https://gisservice.mt.gov/arcgis/rest/services/msdi_cadastral_map_v1/MapServer/1/query';
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 60_000;
const PAUSE_BETWEEN_PAGES_MS = 500;

interface ParcelAttributes {
  PARCELID: string;
  CountyName: string | null;
  AddressLine1: string | null;
  CityStateZip: string | null;
  TotalAcres: number | null;
  GISAcres: number | null;
  TotalBuildingValue: number | null;
  PropType: string | null;
}

interface ParcelFeature {
  attributes: ParcelAttributes;
  geometry?: { rings: number[][][] };
}

interface QueryResponse {
  features?: ParcelFeature[];
  exceededTransferLimit?: boolean;
  error?: { message: string };
}

interface CountyStats {
  processed: number;
  errors: number;
}

async function fetchPage(where: string, offset: number): Promise<QueryResponse> {
  const params = new URLSearchParams({
    where,
    outFields: 'PARCELID,CountyName,AddressLine1,CityStateZip,TotalAcres,GISAcres,TotalBuildingValue,PropType',
    returnGeometry: 'true',
    outSR: '4326',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'json',
  });
  const data = await fetchJson<QueryResponse>(`${CADASTRAL_URL}?${params}`, REQUEST_TIMEOUT_MS);
  if (data.error) throw new Error(`Cadastral query error: ${data.error.message}`);
  return data;
}

function formatAddress(attributes: ParcelAttributes): string | null {
  if (!attributes.AddressLine1) return null;
  const city = attributes.CityStateZip?.trim();
  return `${attributes.AddressLine1.trim()}${city ? `, ${city}` : ''}`;
}

// The parcel point is the boundary centroid, computed in PostGIS.
async function upsertParcel({ attributes, geometry }: ParcelFeature): Promise<void> {
  const boundary = geometry?.rings ? JSON.stringify({ type: 'Polygon', coordinates: geometry.rings }) : null;
  await execute(
    `INSERT INTO parcels (state, county, parcel_number, geo_id, address, acreage, building_value, prop_type, boundary, coordinates)
     SELECT 'MT', $1, $2, $2, $3, $4, $5, $6, b.geom, ST_Centroid(b.geom::geometry)::geography
     FROM (SELECT ST_GeomFromGeoJSON($7)::geography AS geom) b
     ON CONFLICT (state, parcel_number) DO UPDATE SET
       county = EXCLUDED.county,
       address = EXCLUDED.address,
       acreage = EXCLUDED.acreage,
       building_value = EXCLUDED.building_value,
       prop_type = EXCLUDED.prop_type,
       coordinates = COALESCE(EXCLUDED.coordinates, parcels.coordinates),
       boundary = COALESCE(EXCLUDED.boundary, parcels.boundary),
       updated_at = NOW()`,
    [
      attributes.CountyName,
      attributes.PARCELID,
      formatAddress(attributes),
      attributes.TotalAcres ?? attributes.GISAcres,
      attributes.TotalBuildingValue,
      attributes.PropType,
      boundary,
    ]
  );
}

async function scrapeCounty(county: string, minAcres: number): Promise<CountyStats> {
  const where = `CountyName = '${county.replace(/'/g, "''")}' AND TotalAcres >= ${minAcres}`;
  const stats: CountyStats = { processed: 0, errors: 0 };
  console.log(`Scraping ${county} County`);

  for (let offset = 0; ; offset += PAGE_SIZE) {
    let page: QueryResponse;
    try {
      page = await fetchPage(where, offset);
    } catch (err) {
      console.error(`${county}: fetch failed at offset ${offset}:`, err);
      stats.errors++;
      break;
    }
    for (const feature of page.features ?? []) {
      if (!feature.attributes.PARCELID) continue;
      try {
        await upsertParcel(feature);
        stats.processed++;
      } catch (err) {
        console.error(`${county}: failed to save parcel ${feature.attributes.PARCELID}:`, err);
        stats.errors++;
      }
    }
    if (!page.exceededTransferLimit) break;
    await sleep(PAUSE_BETWEEN_PAGES_MS);
  }

  console.log(`${county} County: ${stats.processed} processed, ${stats.errors} errors`);
  return stats;
}

/**
 * Loads parcels for one county (COUNTY) or every county, keeping parcels of at
 * least MIN_ACRES acres. MIN_ACRES defaults to 2 because sub-acre town lots
 * are not what the app is for.
 */
async function main(): Promise<void> {
  const minAcres = Number.parseFloat(process.env.MIN_ACRES ?? '2');
  const counties = process.env.COUNTY ? [process.env.COUNTY] : [...MONTANA_COUNTIES];

  const byCounty: Record<string, CountyStats> = {};
  for (const county of counties) {
    byCounty[county] = await scrapeCounty(county, minAcres);
  }
  const totals = Object.values(byCounty).reduce(
    (sum, stats) => ({ processed: sum.processed + stats.processed, errors: sum.errors + stats.errors }),
    { processed: 0, errors: 0 }
  );
  await writeRunSummary('cadastral', { minAcres, counties: byCounty, totals });
}

void runScraper('Cadastral scraper', main, closePool);
