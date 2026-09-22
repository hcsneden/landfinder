import { execute, closePool } from '../shared/db';
import { fetchJson } from '../shared/http';
import { runScraper, writeRunSummary } from '../shared/runSummary';

// Montana FWP hunting district boundaries. Layer 0 is a group layer that
// rejects queries, so each species layer is queried directly.
const FWP_BASE_URL = 'https://fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer';
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const LAYERS: Array<{ id: number; species: string }> = [
  { id: 1, species: 'big_game' },
  { id: 3, species: 'antelope' },
  { id: 5, species: 'bighorn_sheep' },
  { id: 7, species: 'bison' },
  { id: 10, species: 'black_bear' },
  { id: 11, species: 'deer_elk_lion' },
  { id: 16, species: 'moose' },
  { id: 19, species: 'mountain_goat' },
  { id: 24, species: 'bird' },
  { id: 29, species: 'turkey_spring' },
  { id: 30, species: 'turkey_fall' },
  { id: 31, species: 'upland_game_bird' },
  { id: 35, species: 'furbearer' },
];

// Field names differ between layers. These are tried in order.
const DISTRICT_NUMBER_FIELDS = ['DISTRICT', 'HD_NUMBER', 'DIST_NUM', 'HD_NUM', 'HDNUM', 'NAME', 'OBJECTID'];

interface GeoJsonFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}

interface FeatureCollection {
  features?: GeoJsonFeature[];
  exceededTransferLimit?: boolean;
  error?: { message: string };
}

function districtNumber(properties: Record<string, unknown>): string | null {
  const field = DISTRICT_NUMBER_FIELDS.find((name) => properties[name] != null);
  return field ? String(properties[field]) : null;
}

async function fetchPage(layerId: number, offset: number): Promise<FeatureCollection> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
  });
  const data = await fetchJson<FeatureCollection>(`${FWP_BASE_URL}/${layerId}/query?${params}`, REQUEST_TIMEOUT_MS);
  if (data.error) throw new Error(`FWP layer ${layerId} error: ${data.error.message}`);
  return data;
}

async function upsertDistrict(number: string, species: string, feature: GeoJsonFeature): Promise<void> {
  await execute(
    `INSERT INTO hunting_districts (district_number, species, boundary, raw_data, fetched_at)
     VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography, $4, NOW())
     ON CONFLICT (district_number, species)
     DO UPDATE SET boundary = EXCLUDED.boundary, raw_data = EXCLUDED.raw_data, fetched_at = NOW()`,
    [number, species, JSON.stringify(feature.geometry), JSON.stringify({ ...feature.properties, source: 'fwp_arcgis' })]
  );
}

async function main(): Promise<void> {
  const byLayer: Record<string, { fetched: number; saved: number }> = {};
  let skipped = 0;

  for (const { id: layerId, species } of LAYERS) {
    const stats = { fetched: 0, saved: 0 };
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let page: FeatureCollection;
      try {
        page = await fetchPage(layerId, offset);
      } catch (err) {
        console.warn(`Layer ${layerId} (${species}) fetch failed at offset ${offset}:`, err);
        break;
      }
      const features = page.features ?? [];
      stats.fetched += features.length;
      for (const feature of features) {
        const number = feature.geometry ? districtNumber(feature.properties) : null;
        if (!number) {
          skipped++;
          continue;
        }
        try {
          await upsertDistrict(number, species, feature);
          stats.saved++;
        } catch (err) {
          console.error(`Failed to save district ${number} (${species}):`, err);
          skipped++;
        }
      }
      if (!page.exceededTransferLimit || features.length < PAGE_SIZE) break;
    }
    console.log(`Layer ${layerId} (${species}): ${stats.fetched} fetched, ${stats.saved} saved`);
    byLayer[species] = stats;
  }

  await writeRunSummary('hunting-districts', { source: FWP_BASE_URL, byLayer, skipped });
}

void runScraper('Hunting districts scraper', main, closePool);
