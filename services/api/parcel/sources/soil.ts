import type { SoilInfo, SoilMapUnit } from '@lastbestland/shared';
import { queryOne } from '../../shared/db';
import { fetchJson } from '../../shared/http';
import { withParcelCache, days } from '../../shared/parcelCache';

// USDA Soil Data Access accepts T-SQL over HTTP. SSURGO changes rarely.
const SDA_URL = 'https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest';
const TTL_MS = days(180);
const FETCH_TIMEOUT_MS = 20_000;
const POINT_BUFFER_METERS = 150;

interface SdaResponse {
  /** First row holds column names when the format is JSON+COLUMNNAME. */
  Table?: string[][];
}

// Joins intersecting map units to their aggregate attributes and dominant component.
function buildQuery(wkt: string): string {
  return `
    SELECT m.mukey, m.muname, m.farmlndcl, mag.drclassdcd, mag.slopegraddcp, c.taxclname, c.nirrcapcl
    FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${wkt}') AS i
    JOIN mapunit m ON m.mukey = i.mukey
    LEFT JOIN muaggatt mag ON mag.mukey = m.mukey
    OUTER APPLY (
      SELECT TOP 1 comp.taxclname, comp.nirrcapcl
      FROM component comp WHERE comp.mukey = m.mukey
      ORDER BY comp.comppct_r DESC
    ) c`.replace(/\s+/g, ' ').trim();
}

const orNull = (value: string | undefined) => value || null;

async function fetchMapUnits(wkt: string): Promise<SoilMapUnit[]> {
  const data = await fetchJson<SdaResponse>(
    SDA_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: buildQuery(wkt), format: 'JSON+COLUMNNAME' }),
    },
    FETCH_TIMEOUT_MS
  );
  return (data.Table ?? []).slice(1).map((row) => {
    const slope = Number.parseFloat(row[4] ?? '');
    return {
      mukey: row[0] ?? '',
      name: orNull(row[1]),
      farmlandClass: orNull(row[2]),
      drainageClass: orNull(row[3]),
      slopePercent: Number.isFinite(slope) ? slope : null,
      taxonomicClass: orNull(row[5]),
      capabilityClass: orNull(row[6]),
    };
  });
}

function isPrimeFarmland(farmlandClass: string | null): boolean {
  const label = farmlandClass?.toLowerCase() ?? '';
  return label.includes('prime') && !label.includes('not prime');
}

async function fetchSoil(parcelId: string): Promise<SoilMapUnit[]> {
  // The parcel boundary as WKT, or a circle around the point when no boundary is stored.
  const row = await queryOne<{ wkt: string | null }>(
    `SELECT ST_AsText(COALESCE(boundary, ST_Buffer(coordinates, $2))::geometry) AS wkt
     FROM parcels WHERE id = $1::uuid`,
    [parcelId, POINT_BUFFER_METERS]
  );
  if (!row?.wkt) throw new Error('Parcel has no location');
  return fetchMapUnits(row.wkt);
}

export async function getSoil(parcelId: string, forceRefresh: boolean): Promise<SoilInfo | null> {
  const cached = await withParcelCache('soil', parcelId, TTL_MS, forceRefresh, () => fetchSoil(parcelId));
  if (!cached) return null;
  const mapUnits = cached.payload;
  return {
    parcelId,
    mapUnits,
    primeFarmlandPercent: mapUnits.length
      ? Math.round((mapUnits.filter((unit) => isPrimeFarmland(unit.farmlandClass)).length / mapUnits.length) * 100)
      : null,
    fetchedAt: cached.fetchedAt,
  };
}
