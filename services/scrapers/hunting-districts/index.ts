/**
 * Montana FWP Hunting Districts Scraper
 *
 * Fetches hunting district boundaries from the MT FWP ArcGIS MapServer and
 * stores them as PostGIS geometries. The API handler uses ST_Intersects to
 * find which districts contain a given parcel at query time.
 *
 * Source: https://fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer
 *
 * Layer 0 is a group layer and does not support direct queries. We query the
 * individual species-specific layers that have actual feature data.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { execute, closePool } from '../shared/db';

const FWP_BASE = 'https://fwp-gis.mt.gov/arcgis/rest/services/admbnd/huntingDistricts/MapServer';
const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const S3_BUCKET = process.env.S3_BUCKET || 'landfinder-scraping';

// Layers that have actual queryable district boundaries with meaningful species labels.
// Layer 0 is a display group layer — it rejects all queries.
const LAYERS: { id: number; species: string }[] = [
  { id: 1,  species: 'big_game' },
  { id: 3,  species: 'antelope' },
  { id: 5,  species: 'bighorn_sheep' },
  { id: 7,  species: 'bison' },
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

const s3 = new S3Client({});

interface GeoJSONGeometry {
  type: string;
  coordinates: unknown;
}

interface ArcGISFeature {
  type: 'Feature';
  geometry: GeoJSONGeometry | null;
  properties: Record<string, unknown>;
}

interface ArcGISResponse {
  type: 'FeatureCollection';
  features: ArcGISFeature[];
  exceededTransferLimit?: boolean;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// FWP uses DISTRICT as the district number field across most layers
function extractDistrictNumber(props: Record<string, unknown>): string | null {
  for (const key of ['DISTRICT', 'HD_NUMBER', 'DIST_NUM', 'HD_NUM', 'HDNUM', 'NAME', 'OBJECTID']) {
    if (props[key] != null) return String(props[key]);
  }
  return null;
}

async function fetchLayerPage(layerId: number, offset: number): Promise<ArcGISResponse | null> {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
  });

  const url = `${FWP_BASE}/${layerId}/query?${params}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (err) {
    console.warn(`Layer ${layerId} fetch failed at offset ${offset}:`, err);
    return null;
  }

  if (!response.ok) {
    console.warn(`Layer ${layerId} HTTP ${response.status} at offset ${offset}`);
    return null;
  }

  const raw = await response.json() as Record<string, unknown>;

  if (raw['error']) {
    console.warn(`Layer ${layerId} ArcGIS error:`, raw['error']);
    return null;
  }

  return raw as unknown as ArcGISResponse;
}

async function upsertDistrict(
  districtNumber: string,
  species: string,
  geometry: GeoJSONGeometry,
  rawProps: Record<string, unknown>
): Promise<void> {
  await execute(
    `INSERT INTO hunting_districts (district_number, species, boundary, raw_data, fetched_at)
     VALUES (
       $1, $2,
       ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography,
       $4,
       NOW()
     )
     ON CONFLICT (district_number, species)
     DO UPDATE SET
       boundary   = EXCLUDED.boundary,
       raw_data   = EXCLUDED.raw_data,
       fetched_at = NOW()`,
    [
      districtNumber,
      species,
      JSON.stringify(geometry),
      JSON.stringify({ ...rawProps, source: 'fwp_arcgis', fetchedAt: new Date().toISOString() }),
    ]
  );
}

async function fetchAllHuntingDistricts(): Promise<void> {
  console.log('Fetching hunting districts from MT FWP ArcGIS...');

  let totalFetched = 0;
  let totalSaved = 0;
  let totalSkipped = 0;
  const layerResults: Record<string, { fetched: number; saved: number }> = {};

  for (const { id: layerId, species } of LAYERS) {
    console.log(`\nFetching layer ${layerId} (${species})...`);
    let offset = 0;
    let layerFetched = 0;
    let layerSaved = 0;
    let hasMore = true;

    while (hasMore) {
      const data = await fetchLayerPage(layerId, offset);
      if (!data) break;

      const features = data.features ?? [];
      layerFetched += features.length;

      if (offset === 0 && features.length > 0) {
        console.log(`  Fields: ${Object.keys(features[0]!.properties ?? {}).join(', ')}`);
      }

      for (const feature of features) {
        if (!feature.geometry) {
          totalSkipped++;
          continue;
        }

        const props = feature.properties ?? {};
        const districtNumber = extractDistrictNumber(props);

        if (!districtNumber) {
          console.warn(`  No district number in feature props:`, JSON.stringify(props).slice(0, 150));
          totalSkipped++;
          continue;
        }

        try {
          await upsertDistrict(districtNumber, species, feature.geometry, props);
          layerSaved++;
        } catch (err) {
          console.error(`  Error saving district ${districtNumber}:`, err);
          totalSkipped++;
        }
      }

      hasMore = data.exceededTransferLimit === true && features.length === PAGE_SIZE;
      offset += PAGE_SIZE;
    }

    console.log(`  Layer ${layerId}: ${layerFetched} fetched, ${layerSaved} saved`);
    layerResults[species] = { fetched: layerFetched, saved: layerSaved };
    totalFetched += layerFetched;
    totalSaved += layerSaved;
  }

  const summary = {
    timestamp: new Date().toISOString(),
    source: FWP_BASE,
    layersQueried: LAYERS.length,
    featuresFetched: totalFetched,
    districtsSaved: totalSaved,
    skipped: totalSkipped,
    byLayer: layerResults,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `hunting-districts/runs/${new Date().toISOString().split('T')[0]}.json`,
      Body: JSON.stringify(summary, null, 2),
      ContentType: 'application/json',
    })
  );

  console.log('\nHunting districts fetch complete:', summary);
}

async function main() {
  try {
    await fetchAllHuntingDistricts();
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Hunting districts fetch failed:', err);
  process.exit(1);
});

export { fetchAllHuntingDistricts };
