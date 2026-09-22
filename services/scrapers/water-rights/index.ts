import { parsePriorityDate, parseWaterRightStatus, parseWaterType } from '@lastbestland/shared';
import { query, execute, closePool } from '../shared/db';
import { fetchJson } from '../shared/http';
import { runScraper, writeRunSummary } from '../shared/runSummary';

// DNRC Water Right Query System, geocode layer: one row per water right per parcel geocode.
const WRQS_GEOCODE_URL = 'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query';
const PARCELS_PER_RUN = 500;
const GEOCODES_PER_QUERY = 50;
const REQUEST_TIMEOUT_MS = 15_000;

interface WaterRightAttributes {
  WR_NUMBER: string;
  WR_STATUS: string;
  ENF_PRTY_DT_DATE: number | null;
  ENF_PRTY_DT_CHAR: string | null;
  SOURCE_NAMES: string | null;
  SOURCE_TYPES: string | null;
  MAX_FLOW_GPM: number | null;
  MAX_VOL: number | null;
  GEOCD: string;
  PURPOSES: string | null;
}

interface QueryResponse {
  features?: Array<{ attributes: WaterRightAttributes }>;
  error?: { message: string };
}

interface ParcelRow {
  id: string;
  geo_id: string;
}

async function fetchWaterRights(geocodes: string[]): Promise<WaterRightAttributes[]> {
  const params = new URLSearchParams({
    where: `GEOCD IN (${geocodes.map((geocode) => `'${geocode.replace(/'/g, "''")}'`).join(',')})`,
    outFields: 'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,ENF_PRTY_DT_CHAR,SOURCE_NAMES,SOURCE_TYPES,MAX_FLOW_GPM,MAX_VOL,GEOCD,PURPOSES',
    resultRecordCount: '10000',
    f: 'json',
  });
  const data = await fetchJson<QueryResponse>(`${WRQS_GEOCODE_URL}?${params}`, REQUEST_TIMEOUT_MS);
  if (data.error) throw new Error(`WRQS query error: ${data.error.message}`);
  return (data.features ?? []).map((feature) => feature.attributes);
}

async function saveWaterRight(parcelId: string, right: WaterRightAttributes): Promise<void> {
  await execute(
    `INSERT INTO water_rights (parcel_id, water_right_number, water_source, water_type, flow_rate, volume, priority_date, status, raw_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (parcel_id, water_right_number) DO UPDATE SET
       water_source  = EXCLUDED.water_source,
       water_type    = EXCLUDED.water_type,
       flow_rate     = EXCLUDED.flow_rate,
       volume        = EXCLUDED.volume,
       priority_date = EXCLUDED.priority_date,
       status        = EXCLUDED.status,
       raw_data      = EXCLUDED.raw_data`,
    [
      parcelId,
      right.WR_NUMBER,
      right.SOURCE_NAMES,
      parseWaterType(right.SOURCE_TYPES),
      right.MAX_FLOW_GPM,
      right.MAX_VOL,
      parsePriorityDate(right.ENF_PRTY_DT_DATE, right.ENF_PRTY_DT_CHAR),
      parseWaterRightStatus(right.WR_STATUS),
      JSON.stringify({
        source: 'dnrc_wrqs_api',
        fetchedAt: new Date().toISOString(),
        purposes: right.PURPOSES,
        sourceTypes: right.SOURCE_TYPES,
      }),
    ]
  );
}

/** Fetches water rights for parcels that have none yet, most recently updated first. */
async function main(): Promise<void> {
  const parcels = await query<ParcelRow>(
    `SELECT p.id, p.geo_id FROM parcels p
     WHERE p.state = 'MT' AND p.geo_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM water_rights wr WHERE wr.parcel_id = p.id)
     ORDER BY p.updated_at DESC
     LIMIT $1`,
    [PARCELS_PER_RUN]
  );
  console.log(`Fetching water rights for ${parcels.length} parcels`);

  let waterRightsSaved = 0;
  let errors = 0;
  for (let i = 0; i < parcels.length; i += GEOCODES_PER_QUERY) {
    const batch = parcels.slice(i, i + GEOCODES_PER_QUERY);
    const parcelIdByGeocode = new Map(batch.map((parcel) => [parcel.geo_id, parcel.id]));
    let rights: WaterRightAttributes[];
    try {
      rights = await fetchWaterRights([...parcelIdByGeocode.keys()]);
    } catch (err) {
      console.error(`Batch ${i / GEOCODES_PER_QUERY + 1} fetch failed:`, err);
      errors++;
      continue;
    }
    for (const right of rights) {
      const parcelId = parcelIdByGeocode.get(right.GEOCD);
      if (!parcelId) continue;
      try {
        await saveWaterRight(parcelId, right);
        waterRightsSaved++;
      } catch (err) {
        console.error(`Failed to save water right ${right.WR_NUMBER}:`, err);
        errors++;
      }
    }
  }

  await writeRunSummary('water-rights', { parcelsProcessed: parcels.length, waterRightsSaved, errors });
}

void runScraper('Water rights scraper', main, closePool);
