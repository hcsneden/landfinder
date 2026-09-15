/**
 * Montana DNRC Water Rights Client
 *
 * Fetches water rights data from the DNRC ArcGIS FeatureServer (WRQS).
 * Replaces Playwright-based scraping with direct REST API calls.
 *
 * API: https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query
 * Layer 6 = Geocodes table — returns one row per water right per geocode,
 * with all fields needed (WR_NUMBER, status, priority date, flow, source).
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { query, execute, closePool } from '../shared/db';

const WRQS_FEATURE_SERVER =
  'https://gis.dnrc.mt.gov/arcgis/rest/services/WRD/WRQS/FeatureServer/6/query';

const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;

interface WaterRightData {
  waterRightNumber: string;
  waterSource: string;
  waterType: 'surface' | 'groundwater' | 'mixed';
  flowRateGpm: number | null;
  flowRateCfs: number | null;
  volume: number | null;
  maxAcres: number | null;
  priorityDate: string | null;
  status: 'active' | 'inactive' | 'pending' | 'unknown';
  geocode: string;
  rawData: Record<string, unknown>;
}

interface FeatureAttributes {
  WR_NUMBER: string;
  WR_STATUS: string;
  ENF_PRTY_DT_DATE: number | null;
  ENF_PRTY_DT_CHAR: string | null;
  SOURCE_NAMES: string | null;
  SOURCE_TYPES: string | null;
  MAX_FLOW_GPM: number | null;
  MAX_FLOW_CFS: number | null;
  MAX_VOL: number | null;
  MAX_ACRES: number | null;
  GEOCD: string;
  PURPOSES: string | null;
}

const s3Client = new S3Client({});

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function queryWaterRightsByGeocodes(
  geocodes: string[]
): Promise<Map<string, WaterRightData[]>> {
  const results = new Map<string, WaterRightData[]>();
  if (geocodes.length === 0) return results;

  const geocodeList = geocodes.map((g) => `'${g}'`).join(',');
  const params = new URLSearchParams({
    where: `GEOCD IN (${geocodeList})`,
    outFields:
      'WR_NUMBER,WR_STATUS,ENF_PRTY_DT_DATE,ENF_PRTY_DT_CHAR,SOURCE_NAMES,SOURCE_TYPES,MAX_FLOW_GPM,MAX_FLOW_CFS,MAX_VOL,MAX_ACRES,GEOCD,PURPOSES',
    resultRecordCount: '10000',
    f: 'json',
  });

  const url = `${WRQS_FEATURE_SERVER}?${params}`;

  let data: { features?: { attributes: FeatureAttributes }[]; error?: { message: string } };
  try {
    const response = await fetchWithTimeout(url);
    data = await response.json() as typeof data;
  } catch (err) {
    console.error('DNRC API request failed:', err);
    return results;
  }

  if (data.error) {
    console.error('DNRC API error:', data.error.message);
    return results;
  }

  for (const feature of data.features ?? []) {
    const attr = feature.attributes;
    const geocode = attr.GEOCD;

    const waterRight: WaterRightData = {
      waterRightNumber: attr.WR_NUMBER,
      waterSource: attr.SOURCE_NAMES ?? '',
      waterType: inferWaterType(attr.SOURCE_TYPES ?? ''),
      flowRateGpm: attr.MAX_FLOW_GPM,
      flowRateCfs: attr.MAX_FLOW_CFS,
      volume: attr.MAX_VOL,
      maxAcres: attr.MAX_ACRES,
      priorityDate: parsePriorityDate(attr.ENF_PRTY_DT_DATE, attr.ENF_PRTY_DT_CHAR),
      status: parseStatus(attr.WR_STATUS),
      geocode,
      rawData: {
        fetchedAt: new Date().toISOString(),
        source: 'dnrc_wrqs_api',
        purposes: attr.PURPOSES,
        sourceTypes: attr.SOURCE_TYPES,
      },
    };

    if (!results.has(geocode)) results.set(geocode, []);
    results.get(geocode)!.push(waterRight);
  }

  return results;
}

function inferWaterType(sourceTypes: string): 'surface' | 'groundwater' | 'mixed' {
  const s = sourceTypes.toUpperCase();
  const hasSurface = s.includes('SURFACE');
  const hasGround = s.includes('GROUND');
  if (hasSurface && hasGround) return 'mixed';
  if (hasGround) return 'groundwater';
  return 'surface';
}

function parsePriorityDate(
  epochMs: number | null,
  fallbackChar: string | null
): string | null {
  if (epochMs != null) {
    return new Date(epochMs).toISOString().split('T')[0] ?? null;
  }
  if (fallbackChar) {
    const d = new Date(fallbackChar);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0] ?? null;
  }
  return null;
}

function parseStatus(status: string): 'active' | 'inactive' | 'pending' | 'unknown' {
  const s = status.toUpperCase();
  if (s.includes('ACTIVE') && !s.includes('IN')) return 'active';
  if (
    s.includes('INACTIVE') ||
    s.includes('TERMINATED') ||
    s.includes('ABANDONED') ||
    s.includes('REVOKED')
  ) {
    return 'inactive';
  }
  if (s.includes('PENDING') || s.includes('APPLICATION')) return 'pending';
  return 'unknown';
}

async function saveWaterRight(
  parcelId: string,
  waterRight: WaterRightData
): Promise<void> {
  await execute(
    `INSERT INTO water_rights (
      parcel_id, water_right_number, water_source, water_type,
      flow_rate, volume, priority_date, status, raw_data, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (parcel_id, water_right_number)
    DO UPDATE SET
      water_source  = EXCLUDED.water_source,
      water_type    = EXCLUDED.water_type,
      flow_rate     = EXCLUDED.flow_rate,
      volume        = EXCLUDED.volume,
      priority_date = EXCLUDED.priority_date,
      status        = EXCLUDED.status,
      raw_data      = EXCLUDED.raw_data`,
    [
      parcelId,
      waterRight.waterRightNumber,
      waterRight.waterSource,
      waterRight.waterType,
      waterRight.flowRateGpm,
      waterRight.volume,
      waterRight.priorityDate,
      waterRight.status,
      JSON.stringify(waterRight.rawData),
    ]
  );
}

async function fetchWaterRightsForParcels(): Promise<void> {
  console.log('Fetching water rights from DNRC API...');

  interface ParcelRow {
    id: string;
    geo_id: string;
    parcel_number: string;
  }

  const parcels = await query<ParcelRow>(
    `SELECT p.id, p.geo_id, p.parcel_number
     FROM parcels p
     WHERE p.state = 'MT'
       AND p.geo_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM water_rights wr WHERE wr.parcel_id = p.id
       )
     ORDER BY p.updated_at DESC
     LIMIT 500`,
    []
  );

  console.log(`Found ${parcels.length} parcels to process`);

  const geocodeToParcelId = new Map<string, string>();
  for (const p of parcels) {
    geocodeToParcelId.set(p.geo_id, p.id);
  }

  let totalWaterRights = 0;
  let processedParcels = 0;

  // Process in batches of BATCH_SIZE
  for (let i = 0; i < parcels.length; i += BATCH_SIZE) {
    const batch = parcels.slice(i, i + BATCH_SIZE);
    const geocodes = batch.map((p) => p.geo_id);

    console.log(
      `Batch ${Math.floor(i / BATCH_SIZE) + 1}: querying ${geocodes.length} geocodes...`
    );

    const resultsByGeocode = await queryWaterRightsByGeocodes(geocodes);

    for (const parcel of batch) {
      const waterRights = resultsByGeocode.get(parcel.geo_id) ?? [];

      for (const wr of waterRights) {
        try {
          await saveWaterRight(parcel.id, wr);
        } catch (err) {
          console.error(
            `Error saving water right ${wr.waterRightNumber} for parcel ${parcel.parcel_number}:`,
            err
          );
        }
      }

      totalWaterRights += waterRights.length;
      processedParcels++;

      if (waterRights.length > 0) {
        console.log(
          `${parcel.parcel_number}: ${waterRights.length} water rights`
        );
      }
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    parcelsProcessed: processedParcels,
    waterRightsFound: totalWaterRights,
    batchesExecuted: Math.ceil(parcels.length / BATCH_SIZE),
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || 'landfinder-scraping',
      Key: `water-rights/runs/${new Date().toISOString().split('T')[0]}.json`,
      Body: JSON.stringify(summary, null, 2),
      ContentType: 'application/json',
    })
  );

  console.log('Water rights fetch complete:', summary);
}

// Main entry point
async function main() {
  try {
    await fetchWaterRightsForParcels();
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Water rights fetch failed:', err);
  process.exit(1);
});

export { fetchWaterRightsForParcels, WaterRightData };
