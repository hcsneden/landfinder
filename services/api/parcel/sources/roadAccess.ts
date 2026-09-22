import type { RoadAccess, RoadSegment, RoadType } from '@lastbestland/shared';
import { hasPublicRoadAccess } from '@lastbestland/shared';
import { queryArcGis, polygonGeometryParams, stringAttribute, numberAttribute } from '../../shared/arcgis';
import { withParcelCache, parcelSearchArea, days } from '../../shared/parcelCache';
import { logger } from '../../shared/logger';

const TTL_MS = days(30);
const BOUNDARY_BUFFER_METERS = 150;
// A point may be a centroid far from the road edge on a large rural parcel.
const POINT_BUFFER_METERS = 400;

// TIGERweb splits roads by scale: layer 6 holds primary and secondary roads, layer 8 local roads.
const TIGER_SECONDARY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/6/query';
const TIGER_LOCAL_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8/query';
const BLM_URL = 'https://gis.blm.gov/arcgis/rest/services/Lands_and_Realty/BLM_National_Transportation_Routes/MapServer/0/query';
// ArcGIS Online snapshot of USFS Trans_RoadCore_Existing. The apps.fs.usda.gov host returns 403.
const USFS_URL = 'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/StaticSnapshotForMobile_RoadCoreUSFS/FeatureServer/2/query';

const MTFCC_ROAD_TYPES: Record<string, RoadType> = {
  S1100: 'highway',
  S1200: 'county',
  S1400: 'local',
  S1500: 'trail',
};

function normalizeSurface(raw: unknown): string | null {
  const surface = stringAttribute(raw)?.toLowerCase();
  if (!surface) return null;
  if (/paved|asphalt|concrete/.test(surface)) return 'paved';
  if (/gravel|crushed/.test(surface)) return 'gravel';
  if (/dirt|natural|native/.test(surface)) return 'dirt';
  return surface;
}

async function queryTigerRoads(rings: number[][][]): Promise<RoadSegment[]> {
  const base = { ...polygonGeometryParams(rings), outFields: 'NAME,MTFCC', resultRecordCount: '50', returnGeometry: 'false' };
  const [secondary, local] = await Promise.allSettled([
    queryArcGis(TIGER_SECONDARY_URL, { ...base, where: "MTFCC IN ('S1100','S1200')" }),
    queryArcGis(TIGER_LOCAL_URL, { ...base, where: "MTFCC IN ('S1400','S1500')" }),
  ]);
  const features = [
    ...(secondary.status === 'fulfilled' ? secondary.value : []),
    ...(local.status === 'fulfilled' ? local.value : []),
  ];
  return features.map((feature) => ({
    name: stringAttribute(feature.attributes.NAME),
    type: MTFCC_ROAD_TYPES[String(feature.attributes.MTFCC)] ?? 'unknown',
    source: 'tiger',
    surfaceType: null,
    maintLevel: null,
  }));
}

async function queryBlmRoads(rings: number[][][]): Promise<RoadSegment[]> {
  const features = await queryArcGis(BLM_URL, {
    ...polygonGeometryParams(rings),
    outFields: 'ROUTE_NAME,ROUTE_TYPE,SURFACE_TYPE',
    resultRecordCount: '30',
    returnGeometry: 'false',
  });
  return features.map((feature) => {
    const routeType = (stringAttribute(feature.attributes.ROUTE_TYPE) ?? '').toUpperCase();
    const isTrail = routeType === 'P' || /PRIM|4WD|UNIMPROVED/.test(routeType);
    return {
      name: stringAttribute(feature.attributes.ROUTE_NAME),
      type: isTrail ? 'trail' : 'blm',
      source: 'blm',
      surfaceType: normalizeSurface(feature.attributes.SURFACE_TYPE),
      maintLevel: null,
    };
  });
}

async function queryUsfsRoads(rings: number[][][]): Promise<RoadSegment[]> {
  // Omitting resultRecordCount matters here. On this 585k-feature layer it
  // forces a pagination path that takes seconds. The cap is applied below.
  const features = await queryArcGis(USFS_URL, {
    ...polygonGeometryParams(rings),
    outFields: 'NAME,OPER_MAINT_LEVEL,SURFACE_TYPE',
    returnGeometry: 'false',
  });
  return features.slice(0, 30).map((feature) => {
    const level = numberAttribute(feature.attributes.OPER_MAINT_LEVEL);
    // Maintenance levels 1 and 2 are closed or high-clearance roads.
    const type: RoadType = level !== null && level >= 3 ? 'forest' : 'trail';
    return {
      name: stringAttribute(feature.attributes.NAME),
      type,
      source: 'usfs',
      surfaceType: normalizeSurface(feature.attributes.SURFACE_TYPE),
      maintLevel: level,
    };
  });
}

function dedupeRoads(segments: RoadSegment[]): RoadSegment[] {
  const seen = new Set<string>();
  return segments.filter((segment) => {
    const key = `${segment.source}:${segment.type}:${(segment.name ?? '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchRoadSegments(parcelId: string): Promise<RoadSegment[]> {
  const area = await parcelSearchArea(parcelId, BOUNDARY_BUFFER_METERS, POINT_BUFFER_METERS);
  if (!area) return [];

  const results = await Promise.allSettled([
    queryTigerRoads(area.rings),
    queryBlmRoads(area.rings),
    queryUsfsRoads(area.rings),
  ]);
  results.forEach((result, i) => {
    if (result.status === 'rejected') logger.warn('Road source failed', { source: ['tiger', 'blm', 'usfs'][i], error: String(result.reason) });
  });
  if (results.every((result) => result.status === 'rejected')) throw new Error('All road sources failed');

  return dedupeRoads(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
}

export async function getRoadAccess(parcelId: string, forceRefresh: boolean): Promise<RoadAccess | null> {
  const cached = await withParcelCache('road_access', parcelId, TTL_MS, forceRefresh, () => fetchRoadSegments(parcelId));
  if (!cached) return null;
  return {
    parcelId,
    segments: cached.payload,
    hasPublicAccess: hasPublicRoadAccess(cached.payload),
    fetchedAt: cached.fetchedAt,
  };
}
