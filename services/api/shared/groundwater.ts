/**
 * Nearby well logs, on demand per parcel — MBMG GWIC (Ground Water Information Center).
 *
 * Well *logs* answer the question water rights can't: can you actually get water
 * here, and how deep / productive is it? We pull driller-reported wells within a
 * radius of the parcel and roll them up (median depth / yield / static water level)
 * as a "drillability" signal.
 *
 * Source: MT DNRC "Source Aquifer Explorer" borehole dataset — a queryable ArcGIS
 * FeatureServer of ~192k GWIC wells statewide, hosted by DNRC (same agency as our
 * cadastral feed). Verified live: point geometry, GWIC-keyed, with depth / static
 * water level / yield / aquifer. Follows the same ArcGIS-envelope query +
 * cache-then-fetch pattern as getRoadAccess / getEnvironmentalRisk in parcel/handler.ts.
 *
 * Layer field list: <service>/0?f=json. Depths are feet below ground surface (bgs).
 */
import { queryOne, execute } from './db';
import { logger } from './logger';
import type { GroundwaterInfo, WellLog } from '@lastbestland/shared';

const GWIC_WELLS_URL =
  'https://services2.arcgis.com/DRQySz3VhPgOv7Bo/arcgis/rest/services/Source_Aquifer_Explorer_Borehole_Data/FeatureServer/0/query';

const FIELDS = {
  gwicId: 'gwicid',
  siteName: 'site_name',
  totalDepth: 'total_depth_ft_bgs',
  staticWaterLevel: 'static_water_level_ft_bgs',
  yield: 'yield_gpm',
  aquifer: 'dnrc_source_aquifer_final',
  wellUse: 'all_uses',
  dateCompleted: 'date_completed',
} as const;

const DEFAULT_RADIUS_MILES = 2;
const MAX_WELLS = 25;
const GROUNDWATER_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const FETCH_TIMEOUT_MS = 15_000;
const MILES_PER_DEGREE_LAT = 69.0;

interface CacheRow {
  wells: string;
  radius_miles: number;
  fetched_at: string;
}

interface ArcGisWellFeature {
  attributes: Record<string, unknown>;
  geometry?: { x: number; y: number };
}
interface ArcGisResponse {
  features?: ArcGisWellFeature[];
  error?: { message: string };
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 3958.8; // Earth radius, miles
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function median(values: number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2;
}

async function fetchWells(lat: number, lon: number, radiusMiles: number): Promise<WellLog[]> {
  // Envelope query around the parcel point (degrees). Longitude degrees shrink with latitude.
  const dLat = radiusMiles / MILES_PER_DEGREE_LAT;
  const dLon = radiusMiles / (MILES_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180));

  const params = new URLSearchParams({
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    outFields: Object.values(FIELDS).join(','),
    returnGeometry: 'true',
    resultRecordCount: '200',
    f: 'json',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let data: ArcGisResponse;
  try {
    const res = await fetch(`${GWIC_WELLS_URL}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`GWIC HTTP ${res.status}`);
    data = (await res.json()) as ArcGisResponse;
  } finally {
    clearTimeout(timer);
  }
  if (data.error) throw new Error(`GWIC service error: ${data.error.message}`);

  const wells: WellLog[] = [];
  for (const f of data.features ?? []) {
    if (!f.geometry) continue;
    const distance = haversineMiles(lat, lon, f.geometry.y, f.geometry.x);
    if (distance > radiusMiles) continue; // envelope is a box; clip to the circle

    const a = f.attributes;
    wells.push({
      gwicId: String(a[FIELDS.gwicId] ?? ''),
      siteName: (a[FIELDS.siteName] as string) || null,
      distanceMiles: Math.round(distance * 100) / 100,
      totalDepthFt: num(a[FIELDS.totalDepth]),
      staticWaterLevelFt: num(a[FIELDS.staticWaterLevel]),
      yieldGpm: num(a[FIELDS.yield]),
      aquifer: (a[FIELDS.aquifer] as string) || null,
      wellUse: (a[FIELDS.wellUse] as string) || null,
      dateCompleted: (a[FIELDS.dateCompleted] as string) || null,
    });
  }

  wells.sort((x, y) => x.distanceMiles - y.distanceMiles);
  return wells.slice(0, MAX_WELLS);
}

function rollUp(parcelId: string, wells: WellLog[], radiusMiles: number, fetchedAt: string): GroundwaterInfo {
  return {
    parcelId,
    searchRadiusMiles: radiusMiles,
    wells,
    wellCount: wells.length,
    medianDepthFt: median(wells.map((w) => w.totalDepthFt).filter((v): v is number => v != null)),
    medianYieldGpm: median(wells.map((w) => w.yieldGpm).filter((v): v is number => v != null)),
    medianStaticWaterLevelFt: median(
      wells.map((w) => w.staticWaterLevelFt).filter((v): v is number => v != null)
    ),
    fetchedAt,
  };
}

export async function getGroundwater(
  parcelId: string,
  opts: { forceRefresh?: boolean; radiusMiles?: number } = {}
): Promise<GroundwaterInfo | null> {
  const radiusMiles = opts.radiusMiles ?? DEFAULT_RADIUS_MILES;

  const cached = await queryOne<CacheRow>(
    'SELECT wells::text, radius_miles, fetched_at::text FROM groundwater_cache WHERE parcel_id = $1::uuid',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!opts.forceRefresh && cached && cacheAge <= GROUNDWATER_TTL_MS && cached.radius_miles === radiusMiles) {
    const wells = JSON.parse(cached.wells) as WellLog[];
    return rollUp(parcelId, wells, cached.radius_miles, cached.fetched_at);
  }

  const point = await queryOne<{ lat: number | null; lon: number | null }>(
    `SELECT ST_Y(coordinates::geometry) AS lat, ST_X(coordinates::geometry) AS lon
     FROM parcels WHERE id = $1::uuid`,
    [parcelId]
  );
  if (point?.lat == null || point?.lon == null) return null;

  try {
    const wells = await fetchWells(point.lat, point.lon, radiusMiles);
    const fetchedAt = new Date().toISOString();

    await execute(
      `INSERT INTO groundwater_cache (parcel_id, wells, radius_miles, fetched_at)
       VALUES ($1::uuid, $2::jsonb, $3, NOW())
       ON CONFLICT (parcel_id) DO UPDATE
         SET wells = EXCLUDED.wells, radius_miles = EXCLUDED.radius_miles, fetched_at = NOW()`,
      [parcelId, JSON.stringify(wells), radiusMiles]
    );

    return rollUp(parcelId, wells, radiusMiles, fetchedAt);
  } catch (err) {
    logger.warn('GWIC groundwater query failed', { parcelId, error: String(err) });
    return null;
  }
}
