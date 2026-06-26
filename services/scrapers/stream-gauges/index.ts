/**
 * USGS Stream Gauges Scraper
 *
 * Loads all active Montana streamflow gauge sites from USGS waterservices
 * into the stream_gauges table. The API handler uses ST_DWithin to find
 * gauges near a parcel and fetches/caches their recent readings on demand.
 *
 * Source: https://waterservices.usgs.gov/nwis/site/
 * Parameter 00060 = Discharge (streamflow) in ft³/s
 *
 * Note: waterservices.usgs.gov will be decommissioned in early 2027.
 * Migration target: https://api.waterdata.usgs.gov
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { execute, closePool } from '../shared/db';

const USGS_SITE_URL =
  'https://waterservices.usgs.gov/nwis/site/' +
  '?format=rdb&stateCd=mt&siteType=ST&hasDataTypeCd=dv&parameterCd=00060';

const REQUEST_TIMEOUT_MS = 60_000;
const S3_BUCKET = process.env.S3_BUCKET || 'landfinder-scraping';

const s3 = new S3Client({});

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// RDB is a tab-delimited text format used by USGS.
// Lines starting with # are comments. Line 1 = headers, line 2 = type codes (skip), rest = data.
function parseRdb(text: string): Record<string, string>[] {
  const lines = text.split('\n');
  const dataLines = lines.filter((l) => !l.startsWith('#') && l.trim());

  if (dataLines.length < 3) return [];

  const headers = dataLines[0].split('\t').map((h) => h.trim());
  // dataLines[1] = type codes (e.g. "5s", "15s") — skip
  const rows = dataLines.slice(2);

  return rows
    .filter((l) => l.trim())
    .map((line) => {
      const values = line.split('\t');
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = (values[i] ?? '').trim();
      });
      return obj;
    });
}

// Extracts the stream/river name from USGS station names like:
//   "BITTERROOT RIVER NEAR DARBY MT" -> "Bitterroot River"
//   "CLARK FORK AT MISSOULA MT" -> "Clark Fork"
function extractStreamName(stationName: string): string | null {
  const match = stationName.match(/^(.+?)\s+(?:NEAR|AT|ABOVE|BELOW|NR|BL|AB)\s+/i);
  if (!match) return null;

  return match[1]
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function upsertGauge(row: Record<string, string>): Promise<void> {
  const siteNo = row['site_no'];
  const siteName = row['station_nm'];
  const lat = parseFloat(row['dec_lat_va']);
  const lng = parseFloat(row['dec_long_va']);
  const countyCd = row['county_cd'] || null;
  const hucCode = row['huc_cd'] || null;

  if (!siteNo || !siteName || isNaN(lat) || isNaN(lng)) return;

  const streamName = extractStreamName(siteName);

  await execute(
    `INSERT INTO stream_gauges
       (site_number, site_name, stream_name, coordinates, county_cd, huc_code, fetched_at)
     VALUES (
       $1, $2, $3,
       ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
       $6, $7,
       NOW()
     )
     ON CONFLICT (site_number)
     DO UPDATE SET
       site_name   = EXCLUDED.site_name,
       stream_name = EXCLUDED.stream_name,
       coordinates = EXCLUDED.coordinates,
       county_cd   = EXCLUDED.county_cd,
       huc_code    = EXCLUDED.huc_code,
       fetched_at  = NOW()`,
    [siteNo, siteName, streamName, lng, lat, countyCd, hucCode]
  );
}

async function fetchMontanaStreamGauges(): Promise<void> {
  console.log('Fetching MT stream gauges from USGS...');

  const response = await fetchWithTimeout(USGS_SITE_URL);

  if (!response.ok) {
    throw new Error(`USGS site service HTTP ${response.status}`);
  }

  const text = await response.text();
  const rows = parseRdb(text);

  console.log(`Parsed ${rows.length} gauge records from USGS`);

  let saved = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      await upsertGauge(row);
      saved++;
    } catch (err) {
      console.error(`Error saving gauge ${row['site_no']}:`, err);
      skipped++;
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    source: USGS_SITE_URL,
    rowsParsed: rows.length,
    gaugesSaved: saved,
    skipped,
  };

  await s3.send(
    new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `stream-gauges/runs/${new Date().toISOString().split('T')[0]}.json`,
      Body: JSON.stringify(summary, null, 2),
      ContentType: 'application/json',
    })
  );

  console.log('Stream gauges fetch complete:', summary);
}

async function main() {
  try {
    await fetchMontanaStreamGauges();
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Stream gauges fetch failed:', err);
  process.exit(1);
});

export { fetchMontanaStreamGauges };
