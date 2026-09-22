import type { StreamGauge, StreamGaugeReading } from '@lastbestland/shared';
import { query, execute } from '../../shared/db';
import { fetchJson } from '../../shared/http';
import { logger } from '../../shared/logger';

// USGS NWIS daily values. USGS plans to retire this host in favor of
// api.waterdata.usgs.gov, so treat it as a migration candidate.
const USGS_DAILY_VALUES_URL = 'https://waterservices.usgs.gov/nwis/dv/';
const DISCHARGE_PARAMETER_CODE = '00060';
const DAILY_MEAN_STATISTIC_CODE = '00003';

const SEARCH_RADIUS_METERS = 80_467; // 50 miles
const MAX_NEARBY_GAUGES = 5;
const READINGS_TTL_MS = 24 * 60 * 60 * 1000;
const METERS_PER_MILE = 1609.344;

interface GaugeRow {
  id: string;
  site_number: string;
  site_name: string;
  stream_name: string | null;
  distance_miles: number;
  latest_fetched_at: string | null;
}

interface ReadingRow {
  reading_date: string;
  mean_flow_cfs: number;
}

interface UsgsDailyValuesResponse {
  value?: {
    timeSeries?: Array<{ values?: Array<{ value?: Array<{ value: string; dateTime: string }> }> }>;
  };
}

async function fetchUsgsReadings(siteNumber: string): Promise<StreamGaugeReading[]> {
  const params = new URLSearchParams({
    format: 'json',
    sites: siteNumber,
    parameterCd: DISCHARGE_PARAMETER_CODE,
    statCd: DAILY_MEAN_STATISTIC_CODE,
    period: 'P365D',
  });
  const data = await fetchJson<UsgsDailyValuesResponse>(`${USGS_DAILY_VALUES_URL}?${params}`);
  const values = data.value?.timeSeries?.[0]?.values?.[0]?.value ?? [];
  const readings: StreamGaugeReading[] = [];
  for (const entry of values) {
    const cfs = Number.parseFloat(entry.value);
    // USGS encodes missing data as a large negative number.
    if (Number.isNaN(cfs) || cfs < 0) continue;
    readings.push({ date: entry.dateTime.slice(0, 10), meanFlowCfs: cfs });
  }
  return readings;
}

async function cacheReadings(gaugeId: string, readings: StreamGaugeReading[]): Promise<void> {
  if (readings.length === 0) return;
  await execute(
    `INSERT INTO stream_gauge_readings (gauge_id, reading_date, mean_flow_cfs, fetched_at)
     SELECT $1::uuid, unnest($2::date[]), unnest($3::numeric[]), NOW()
     ON CONFLICT (gauge_id, reading_date)
     DO UPDATE SET mean_flow_cfs = EXCLUDED.mean_flow_cfs, fetched_at = NOW()`,
    [gaugeId, readings.map((r) => r.date), readings.map((r) => r.meanFlowCfs)]
  );
}

export function monthlyAverages(readings: StreamGaugeReading[]): Record<number, number> {
  const byMonth = new Map<number, number[]>();
  for (const reading of readings) {
    const month = new Date(reading.date).getUTCMonth() + 1;
    byMonth.set(month, [...(byMonth.get(month) ?? []), reading.meanFlowCfs]);
  }
  const averages: Record<number, number> = {};
  for (const [month, values] of byMonth) {
    averages[month] = Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
  }
  return averages;
}

async function refreshReadingsIfStale(gauge: GaugeRow): Promise<void> {
  const lastFetch = gauge.latest_fetched_at ? new Date(gauge.latest_fetched_at).getTime() : 0;
  if (Date.now() - lastFetch <= READINGS_TTL_MS) return;
  try {
    await cacheReadings(gauge.id, await fetchUsgsReadings(gauge.site_number));
  } catch (err) {
    logger.warn('USGS reading fetch failed', { siteNumber: gauge.site_number, error: String(err) });
  }
}

async function toStreamGauge(gauge: GaugeRow): Promise<StreamGauge> {
  await refreshReadingsIfStale(gauge);
  const rows = await query<ReadingRow>(
    `SELECT reading_date::text AS reading_date, mean_flow_cfs
     FROM stream_gauge_readings WHERE gauge_id = $1::uuid
     ORDER BY reading_date DESC LIMIT 365`,
    [gauge.id]
  );
  const readings = rows.map((row) => ({ date: row.reading_date, meanFlowCfs: row.mean_flow_cfs }));
  const latest = readings[0] ?? null;
  return {
    id: gauge.id,
    siteNumber: gauge.site_number,
    siteName: gauge.site_name,
    streamName: gauge.stream_name,
    distanceMiles: Math.round(gauge.distance_miles * 10) / 10,
    latestFlowCfs: latest?.meanFlowCfs ?? null,
    latestReadingDate: latest?.date ?? null,
    readings,
    monthlyAveragesCfs: monthlyAverages(readings),
  };
}

/** Returns the nearest gauges within 50 miles, each with up to a year of daily readings. */
export async function getStreamGauges(parcelId: string): Promise<StreamGauge[]> {
  const gauges = await query<GaugeRow>(
    `SELECT sg.id, sg.site_number, sg.site_name, sg.stream_name,
       ST_Distance(sg.coordinates, p.coordinates) / $4 AS distance_miles,
       (SELECT MAX(fetched_at)::text FROM stream_gauge_readings WHERE gauge_id = sg.id) AS latest_fetched_at
     FROM stream_gauges sg
     JOIN parcels p ON p.id = $1::uuid
     WHERE ST_DWithin(sg.coordinates, p.coordinates, $2)
     ORDER BY distance_miles
     LIMIT $3`,
    [parcelId, SEARCH_RADIUS_METERS, MAX_NEARBY_GAUGES, METERS_PER_MILE]
  );
  return Promise.all(gauges.map(toStreamGauge));
}
