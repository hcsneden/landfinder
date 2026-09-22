/**
 * NRCS SSURGO soils, on demand per parcel.
 *
 * Uses USDA Soil Data Access (SDA), a public T-SQL-over-HTTP service. We send a
 * WKT polygon of the parcel (WGS84) to the spatial helper
 * SDA_Get_Mukey_from_intersection_with_WktWgs84(), then join the intersecting
 * map units to their aggregate attributes (muaggatt) and dominant component
 * (component, highest comppct_r) for taxonomy / land-capability class.
 *
 * Endpoint + query shape: https://sdmdataaccess.nrcs.usda.gov/documents/AdvancedQueries.html
 * The POST /Tabular/post.rest endpoint returns { "Table": [[col names...], [row...], ...] }
 * when format is "JSON+COLUMNNAME".
 *
 * Mirrors the cache-then-fetch pattern used by getEnvironmentalRisk in parcel/handler.ts.
 */
import { queryOne, execute } from './db';
import { logger } from './logger';
import type { SoilInfo, SoilMapUnit } from '@lastbestland/shared';

const SDA_URL = 'https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest';
const SOIL_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days — SSURGO changes rarely
const FETCH_TIMEOUT_MS = 20_000;

interface CacheRow {
  map_units: string;
  fetched_at: string;
}

// SDA returns rows as string[]; index into them by the column order we SELECT below.
type SdaRow = string[];
interface SdaResponse {
  Table?: SdaRow[];
}

function buildQuery(wkt: string): string {
  // Escape is unnecessary — WKT is numeric coords only — but keep the polygon on one line.
  return `
    SELECT
      m.mukey,
      m.muname,
      m.farmlndcl,
      mag.drclassdcd,
      mag.slopegraddcp,
      c.taxclname,
      c.nirrcapcl
    FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}') AS i
    JOIN mapunit m ON m.mukey = i.mukey
    LEFT JOIN muaggatt mag ON mag.mukey = m.mukey
    OUTER APPLY (
      SELECT TOP 1 comp.taxclname, comp.nirrcapcl
      FROM component comp
      WHERE comp.mukey = m.mukey
      ORDER BY comp.comppct_r DESC
    ) c
  `.replace(/\s+/g, ' ').trim();
}

async function fetchSda(wkt: string): Promise<SoilMapUnit[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SDA_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: buildQuery(wkt), format: 'JSON+COLUMNNAME' }),
    });
    // SDA puts the actual SQL error in the body, so include it or the log says nothing useful.
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SDA HTTP ${res.status} ${body.slice(0, 300)}`.trim());
    }
    const data = (await res.json()) as SdaResponse;

    const table = data.Table ?? [];
    // First row is column names when format is JSON+COLUMNNAME — skip it.
    const rows = table.slice(1);

    return rows.map((r) => {
      const slope = r[4] != null && r[4] !== '' ? Number(r[4]) : null;
      return {
        mukey: r[0] ?? '',
        name: r[1] || null,
        // Area within the parcel needs a geometry-clip query; left null in this prototype.
        acresInParcel: null,
        percentOfParcel: null,
        farmlandClass: r[2] || null,
        drainageClass: r[3] || null,
        slopePercent: slope != null && Number.isFinite(slope) ? slope : null,
        taxonomicClass: r[5] || null,
        capabilityClass: r[6] || null,
      };
    });
  } finally {
    clearTimeout(timer);
  }
}

function isPrime(farmlandClass: string | null): boolean {
  if (!farmlandClass) return false;
  return farmlandClass.toLowerCase().includes('prime') &&
    !farmlandClass.toLowerCase().includes('not prime');
}

export async function getSoilInfo(
  parcelId: string,
  opts: { forceRefresh?: boolean } = {}
): Promise<SoilInfo | null> {
  const cached = await queryOne<CacheRow>(
    'SELECT map_units::text, fetched_at::text FROM soil_info_cache WHERE parcel_id = $1::uuid',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!opts.forceRefresh && cached && cacheAge <= SOIL_TTL_MS) {
    const mapUnits = JSON.parse(cached.map_units) as SoilMapUnit[];
    return rollUp(parcelId, mapUnits, cached.fetched_at);
  }

  // Prefer the actual parcel boundary as WKT; fall back to a ~150m buffer around the point.
  const geom = await queryOne<{ wkt: string | null }>(
    `SELECT ST_AsText(
       COALESCE(
         boundary::geometry,
         ST_Buffer(ST_SetSRID(ST_MakePoint(ST_X(coordinates::geometry), ST_Y(coordinates::geometry)), 4326)::geography, 150)::geometry
       )
     ) AS wkt
     FROM parcels WHERE id = $1::uuid`,
    [parcelId]
  );
  if (!geom?.wkt) return null;

  try {
    const mapUnits = await fetchSda(geom.wkt);
    const fetchedAt = new Date().toISOString();

    await execute(
      `INSERT INTO soil_info_cache (parcel_id, map_units, fetched_at)
       VALUES ($1::uuid, $2::jsonb, NOW())
       ON CONFLICT (parcel_id) DO UPDATE
         SET map_units = EXCLUDED.map_units, fetched_at = NOW()`,
      [parcelId, JSON.stringify(mapUnits)]
    );

    return rollUp(parcelId, mapUnits, fetchedAt);
  } catch (err) {
    logger.warn('SDA SSURGO query failed', { parcelId, error: String(err) });
    return null;
  }
}

function rollUp(parcelId: string, mapUnits: SoilMapUnit[], fetchedAt: string): SoilInfo {
  // Until per-unit area is available, weight prime farmland by unit count, not acreage.
  const primeFarmlandPercent = mapUnits.length
    ? Math.round((mapUnits.filter((u) => isPrime(u.farmlandClass)).length / mapUnits.length) * 100)
    : null;

  return {
    parcelId,
    mapUnits,
    primeFarmlandPercent,
    dominantMapUnitName: mapUnits[0]?.name ?? null,
    fetchedAt,
  };
}
