import type { GroundwaterInfo, WellLog } from '@lastbestland/shared';
import { queryOne } from '../../shared/db';
import { queryArcGis, numberAttribute, stringAttribute, type ArcGisFeature } from '../../shared/arcgis';
import { withParcelCache, days } from '../../shared/parcelCache';

// DNRC Source Aquifer Explorer, a feature service of MBMG GWIC well logs.
// Field list: <service>/0?f=json. Depths are feet below ground surface.
const GWIC_WELLS_URL = 'https://services2.arcgis.com/DRQySz3VhPgOv7Bo/arcgis/rest/services/Source_Aquifer_Explorer_Borehole_Data/FeatureServer/0/query';
const TTL_MS = days(90);
const FETCH_TIMEOUT_MS = 15_000;

export const DEFAULT_RADIUS_MILES = 2;
export const MAX_RADIUS_MILES = 10;
const MAX_WELLS = 25;
const MILES_PER_DEGREE_LATITUDE = 69;
const EARTH_RADIUS_MILES = 3958.8;

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

interface GroundwaterPayload {
  radiusMiles: number;
  wells: WellLog[];
}

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a));
}

export function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function toWellLog(feature: ArcGisFeature, distanceMiles: number): WellLog {
  const a = feature.attributes;
  return {
    gwicId: String(a[FIELDS.gwicId] ?? ''),
    siteName: stringAttribute(a[FIELDS.siteName]),
    distanceMiles: Math.round(distanceMiles * 100) / 100,
    totalDepthFt: numberAttribute(a[FIELDS.totalDepth]),
    staticWaterLevelFt: numberAttribute(a[FIELDS.staticWaterLevel]),
    yieldGpm: numberAttribute(a[FIELDS.yield]),
    aquifer: stringAttribute(a[FIELDS.aquifer]),
    wellUse: stringAttribute(a[FIELDS.wellUse]),
    dateCompleted: stringAttribute(a[FIELDS.dateCompleted]),
  };
}

async function fetchWells(lat: number, lon: number, radiusMiles: number): Promise<WellLog[]> {
  // Envelope around the point in degrees. Longitude degrees shrink with latitude.
  const dLat = radiusMiles / MILES_PER_DEGREE_LATITUDE;
  const dLon = radiusMiles / (MILES_PER_DEGREE_LATITUDE * Math.cos((lat * Math.PI) / 180));
  const features = await queryArcGis(GWIC_WELLS_URL, {
    geometry: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outSR: '4326',
    outFields: Object.values(FIELDS).join(','),
    returnGeometry: 'true',
    resultRecordCount: '200',
  }, FETCH_TIMEOUT_MS);

  const wells: WellLog[] = [];
  for (const feature of features) {
    if (feature.geometry?.x === undefined || feature.geometry.y === undefined) continue;
    const distance = haversineMiles(lat, lon, feature.geometry.y, feature.geometry.x);
    // The envelope is a box. Clip it to the circle.
    if (distance <= radiusMiles) wells.push(toWellLog(feature, distance));
  }
  return wells.sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, MAX_WELLS);
}

async function fetchGroundwater(parcelId: string, radiusMiles: number): Promise<GroundwaterPayload> {
  const point = await queryOne<{ lat: number | null; lon: number | null }>(
    'SELECT ST_Y(coordinates::geometry) AS lat, ST_X(coordinates::geometry) AS lon FROM parcels WHERE id = $1::uuid',
    [parcelId]
  );
  if (point?.lat === null || point?.lat === undefined || point.lon === null) throw new Error('Parcel has no location');
  return { radiusMiles, wells: await fetchWells(point.lat, point.lon, radiusMiles) };
}

export async function getGroundwater(
  parcelId: string,
  forceRefresh: boolean,
  radiusMiles = DEFAULT_RADIUS_MILES
): Promise<GroundwaterInfo | null> {
  const cached = await withParcelCache('groundwater', parcelId, TTL_MS, forceRefresh, () => fetchGroundwater(parcelId, radiusMiles));
  if (!cached) return null;
  // A cached result for a different radius is not reusable.
  const result = cached.payload.radiusMiles === radiusMiles
    ? cached
    : await withParcelCache('groundwater', parcelId, TTL_MS, true, () => fetchGroundwater(parcelId, radiusMiles));
  if (!result) return null;

  const { wells } = result.payload;
  const values = (pick: (well: WellLog) => number | null) => wells.map(pick).filter((v): v is number => v !== null);
  return {
    parcelId,
    searchRadiusMiles: result.payload.radiusMiles,
    wells,
    wellCount: wells.length,
    medianDepthFt: median(values((well) => well.totalDepthFt)),
    medianYieldGpm: median(values((well) => well.yieldGpm)),
    medianStaticWaterLevelFt: median(values((well) => well.staticWaterLevelFt)),
    fetchedAt: result.fetchedAt,
  };
}
