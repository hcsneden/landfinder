import { execute, closePool } from '../shared/db';
import { fetchWithTimeout } from '../shared/http';
import { runScraper, writeRunSummary } from '../shared/runSummary';
import { parseRdb, extractStreamName } from './rdb';

// Active Montana stream gauges with daily discharge (parameter 00060). USGS
// plans to retire this host in favor of api.waterdata.usgs.gov.
const USGS_SITES_URL =
  'https://waterservices.usgs.gov/nwis/site/?format=rdb&stateCd=mt&siteType=ST&hasDataTypeCd=dv&parameterCd=00060';
const REQUEST_TIMEOUT_MS = 60_000;

async function upsertGauge(row: Record<string, string>): Promise<boolean> {
  const siteNumber = row.site_no;
  const siteName = row.station_nm;
  const lat = Number.parseFloat(row.dec_lat_va ?? '');
  const lng = Number.parseFloat(row.dec_long_va ?? '');
  if (!siteNumber || !siteName || Number.isNaN(lat) || Number.isNaN(lng)) return false;

  await execute(
    `INSERT INTO stream_gauges (site_number, site_name, stream_name, coordinates, county_cd, huc_code, fetched_at)
     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography, $6, $7, NOW())
     ON CONFLICT (site_number) DO UPDATE SET
       site_name = EXCLUDED.site_name,
       stream_name = EXCLUDED.stream_name,
       coordinates = EXCLUDED.coordinates,
       county_cd = EXCLUDED.county_cd,
       huc_code = EXCLUDED.huc_code,
       fetched_at = NOW()`,
    [siteNumber, siteName, extractStreamName(siteName), lng, lat, row.county_cd || null, row.huc_cd || null]
  );
  return true;
}

async function main(): Promise<void> {
  const response = await fetchWithTimeout(USGS_SITES_URL, REQUEST_TIMEOUT_MS);
  const rows = parseRdb(await response.text());
  console.log(`Parsed ${rows.length} gauge records`);

  let saved = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      if (await upsertGauge(row)) saved++;
      else skipped++;
    } catch (err) {
      console.error(`Failed to save gauge ${row.site_no}:`, err);
      skipped++;
    }
  }
  await writeRunSummary('stream-gauges', { source: USGS_SITES_URL, rowsParsed: rows.length, saved, skipped });
}

void runScraper('Stream gauges scraper', main, closePool);
