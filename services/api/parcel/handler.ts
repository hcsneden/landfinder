import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { query, queryOne, execute } from '../shared/db';
import { success, badRequest, notFound, serverError, error as errorResponse } from '../shared/response';
import { generateBuildabilitySummary, BEDROCK_MODEL_ID } from '../shared/bedrock';
import { getOrCheckListingStatus } from '../shared/listingStatus';
import { getSoilInfo } from '../shared/soil';
import { getGroundwater } from '../shared/groundwater';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import type { Parcel, WaterRight, Listing, ParcelInsight, HuntingDistrict, StreamGauge, StreamGaugeReading, RoadSegment, RoadAccess, RoadType, UtilityAccess, ElectricAccess, BroadbandProvider, EnvironmentalRisk, FloodZone, FloodRiskLevel, WildfireRiskRating, MineSite, ConservationEasement, ListingStatus } from '@landfinder/shared';

interface ParcelRow {
  id: string;
  state: string;
  county: string | null;
  parcel_number: string | null;
  geo_id: string | null;
  address: string | null;
  acreage: number | null;
  building_value: number | null;
  prop_type: string | null;
  longitude: number | null;
  latitude: number | null;
  boundary: string | null;
  created_at: string;
  updated_at: string;
}

interface WaterRightRow {
  id: string;
  parcel_id: string;
  water_right_number: string | null;
  water_source: string | null;
  water_type: string | null;
  flow_rate: number | null;
  volume: number | null;
  priority_date: string | null;
  status: string | null;
  raw_data: Record<string, unknown>;
  created_at: string;
}

interface ListingRow {
  id: string;
  parcel_id: string;
  source: string;
  source_id: string;
  price: number | null;
  listing_url: string;
  description: string | null;
  images: string[];
  listed_at: string | null;
  scraped_at: string;
  raw_data: Record<string, unknown>;
}

interface InsightRow {
  id: string;
  parcel_id: string;
  insight_type: string;
  content: string;
  model_version: string;
  created_at: string;
}

async function getParcel(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) {
    return badRequest('Parcel ID is required');
  }

  const sql = `
    SELECT
      id,
      state,
      county,
      parcel_number,
      geo_id,
      address,
      acreage,
      building_value,
      prop_type,
      ST_X(coordinates::geometry) as longitude,
      ST_Y(coordinates::geometry) as latitude,
      ST_AsGeoJSON(boundary)::text as boundary,
      created_at,
      updated_at
    FROM parcels
    WHERE id = $1::uuid
  `;

  const row = await queryOne<ParcelRow>(sql, [parcelId]);

  if (!row) {
    logger.warn('Parcel not found', { parcelId });
    return notFound('Parcel not found');
  }

  const parcel: Parcel = {
    id: row.id,
    state: row.state,
    county: row.county,
    parcelNumber: row.parcel_number,
    geoId: row.geo_id,
    address: row.address,
    acreage: row.acreage,
    buildingValue: row.building_value,
    propType: row.prop_type,
    coordinates:
      row.latitude && row.longitude
        ? { latitude: row.latitude, longitude: row.longitude }
        : null,
    boundary: row.boundary ? JSON.parse(row.boundary as string) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  metrics.addMetric('ParcelDetailFetched', MetricUnit.Count, 1);
  return success(parcel);
}

async function getWaterRights(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) {
    return badRequest('Parcel ID is required');
  }

  const sql = `
    SELECT
      id,
      parcel_id,
      water_right_number,
      water_source,
      water_type,
      flow_rate,
      volume,
      priority_date,
      status,
      raw_data,
      created_at
    FROM water_rights
    WHERE parcel_id = $1::uuid
    ORDER BY priority_date ASC
  `;

  const rows = await query<WaterRightRow>(sql, [parcelId]);

  const waterRights: WaterRight[] = rows.map((row) => ({
    id: row.id,
    parcelId: row.parcel_id,
    waterRightNumber: row.water_right_number,
    waterSource: row.water_source,
    waterType: row.water_type as WaterRight['waterType'],
    flowRate: row.flow_rate,
    volume: row.volume,
    priorityDate: row.priority_date,
    status: (row.status as WaterRight['status']) || 'unknown',
    rawData: row.raw_data,
    createdAt: row.created_at,
  }));

  return success(waterRights);
}

async function getListings(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) {
    return badRequest('Parcel ID is required');
  }

  const sql = `
    SELECT
      id,
      parcel_id,
      source,
      source_id,
      price,
      listing_url,
      description,
      images,
      listed_at,
      scraped_at,
      raw_data
    FROM listings
    WHERE parcel_id = $1::uuid
    ORDER BY scraped_at DESC
  `;

  const rows = await query<ListingRow>(sql, [parcelId]);

  const listings: Listing[] = rows.map((row) => ({
    id: row.id,
    parcelId: row.parcel_id,
    source: row.source as Listing['source'],
    sourceId: row.source_id,
    price: row.price,
    listingUrl: row.listing_url,
    description: row.description,
    images: row.images || [],
    listedAt: row.listed_at,
    scrapedAt: row.scraped_at,
    rawData: row.raw_data,
  }));

  return success(listings);
}

// ---------------------------------------------------------------------------
// Hunting Districts
// ---------------------------------------------------------------------------

interface HuntingDistrictRow {
  id: string;
  district_number: string;
  species: string;
  raw_data: Record<string, unknown>;
}

async function getHuntingDistricts(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  // Use the parcel boundary when available; fall back to a small buffer around the centroid.
  const sql = `
    SELECT hd.id, hd.district_number, hd.species, hd.raw_data
    FROM hunting_districts hd
    JOIN parcels p ON p.id = $1::uuid
    WHERE ST_Intersects(
      hd.boundary,
      COALESCE(
        p.boundary,
        ST_Buffer(p.coordinates::geometry, 100)::geography
      )
    )
    ORDER BY hd.species, hd.district_number
  `;

  const rows = await query<HuntingDistrictRow>(sql, [parcelId]);

  const districts: HuntingDistrict[] = rows.map((row) => ({
    id: row.id,
    districtNumber: row.district_number,
    species: row.species,
    rawData: row.raw_data,
  }));

  metrics.addMetric('HuntingDistrictsFetched', MetricUnit.Count, 1);
  return success(districts);
}

// ---------------------------------------------------------------------------
// Stream Gauges
// ---------------------------------------------------------------------------

const USGS_DV_BASE = 'https://waterservices.usgs.gov/nwis/dv/';
const GAUGE_SEARCH_RADIUS_METERS = 80_467; // 50 miles
const MAX_NEARBY_GAUGES = 5;
const READINGS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

interface USGSDVResponse {
  value?: {
    timeSeries?: Array<{
      values?: Array<{
        value?: Array<{
          value: string;
          dateTime: string;
        }>;
      }>;
    }>;
  };
}

async function fetchUsgsReadings(siteNumber: string): Promise<{ date: string; cfs: number }[]> {
  const params = new URLSearchParams({
    format: 'json',
    sites: siteNumber,
    parameterCd: '00060',
    statCd: '00003',
    period: 'P365D',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let data: USGSDVResponse;
  try {
    const res = await fetch(`${USGS_DV_BASE}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`USGS DV HTTP ${res.status}`);
    data = await res.json() as USGSDVResponse;
  } finally {
    clearTimeout(timer);
  }

  const readings: { date: string; cfs: number }[] = [];
  const values = data.value?.timeSeries?.[0]?.values?.[0]?.value ?? [];

  for (const v of values) {
    const cfs = parseFloat(v.value);
    if (isNaN(cfs) || cfs < 0) continue; // USGS uses -999999 for missing data
    const date = v.dateTime.split('T')[0] ?? v.dateTime;
    readings.push({ date, cfs });
  }

  return readings;
}

async function cacheReadings(gaugeId: string, readings: { date: string; cfs: number }[]): Promise<void> {
  if (readings.length === 0) return;
  await execute(
    `INSERT INTO stream_gauge_readings (gauge_id, reading_date, mean_flow_cfs, fetched_at)
     SELECT $1::uuid, unnest($2::date[]), unnest($3::numeric[]), NOW()
     ON CONFLICT (gauge_id, reading_date)
     DO UPDATE SET mean_flow_cfs = EXCLUDED.mean_flow_cfs, fetched_at = NOW()`,
    [gaugeId, readings.map((r) => r.date), readings.map((r) => r.cfs)]
  );
}

function buildMonthlyAverages(readings: StreamGaugeReading[]): Record<number, number> {
  const buckets: Record<number, number[]> = {};
  for (const r of readings) {
    const month = new Date(r.date).getUTCMonth() + 1;
    if (!buckets[month]) buckets[month] = [];
    buckets[month].push(r.meanFlowCfs);
  }
  const avgs: Record<number, number> = {};
  for (const [month, vals] of Object.entries(buckets)) {
    avgs[Number(month)] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
  }
  return avgs;
}

async function getStreamGauges(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  // Find gauges within 50 miles of the parcel centroid
  const gaugeRows = await query<GaugeRow>(
    `SELECT
       sg.id,
       sg.site_number,
       sg.site_name,
       sg.stream_name,
       ST_Distance(sg.coordinates, p.coordinates) / 1609.344 AS distance_miles,
       (SELECT MAX(fetched_at)::text FROM stream_gauge_readings WHERE gauge_id = sg.id) AS latest_fetched_at
     FROM stream_gauges sg
     JOIN parcels p ON p.id = $1::uuid
     WHERE ST_DWithin(sg.coordinates, p.coordinates, $2)
     ORDER BY distance_miles
     LIMIT $3`,
    [parcelId, GAUGE_SEARCH_RADIUS_METERS, MAX_NEARBY_GAUGES]
  );

  if (gaugeRows.length === 0) {
    return success([]);
  }

  const result = await Promise.all(gaugeRows.map(async (gauge) => {
    // Refresh readings if cache is stale or empty
    const lastFetch = gauge.latest_fetched_at ? new Date(gauge.latest_fetched_at).getTime() : 0;
    const stale = Date.now() - lastFetch > READINGS_TTL_MS;

    if (stale) {
      try {
        const fresh = await fetchUsgsReadings(gauge.site_number);
        if (fresh.length > 0) {
          await cacheReadings(gauge.id, fresh);
        }
      } catch (err) {
        logger.warn('USGS reading fetch failed', {
          siteNumber: gauge.site_number,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const readingRows = await query<ReadingRow>(
      `SELECT reading_date::text AS reading_date, mean_flow_cfs
       FROM stream_gauge_readings
       WHERE gauge_id = $1::uuid
       ORDER BY reading_date DESC
       LIMIT 365`,
      [gauge.id]
    );

    const readings: StreamGaugeReading[] = readingRows.map((r) => ({
      date: r.reading_date,
      meanFlowCfs: Number(r.mean_flow_cfs),
    }));

    const latestReading = readings[0] ?? null;

    return {
      id: gauge.id,
      siteNumber: gauge.site_number,
      siteName: gauge.site_name,
      streamName: gauge.stream_name,
      distanceMiles: Math.round(gauge.distance_miles * 10) / 10,
      latestFlowCfs: latestReading ? latestReading.meanFlowCfs : null,
      latestReadingDate: latestReading ? latestReading.date : null,
      readings,
      monthlyAveragesCfs: buildMonthlyAverages(readings),
    };
  }));

  metrics.addMetric('StreamGaugesFetched', MetricUnit.Count, 1);
  return success(result);
}

// ---------------------------------------------------------------------------
// Road Access
// ---------------------------------------------------------------------------

const ROAD_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — road networks change rarely

// TIGER Transportation: layer 6 = secondary (US/state highways, S1200), layer 8 = local roads (S1400/S1500)
// (EDGES/MapServer/0 was retired; Transportation/MapServer replaced it with scale-split layers)
const TIGER_SECONDARY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/6/query';
const TIGER_LOCAL_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/8/query';
// BLM National Transportation Routes
const BLM_URL = 'https://gis.blm.gov/arcgis/rest/services/Lands_and_Realty/BLM_National_Transportation_Routes/MapServer/0/query';
// USFS Road Core — ArcGIS Online mirror (apps.fs.usda.gov/arcgis returns 403 server-wide)
// Layer 2 = Trans_RoadCore_Existing (annually updated snapshot by USFSEnterpriseContent)
const USFS_URL = 'https://services1.arcgis.com/gGHDlz6USftL5Pau/arcgis/rest/services/StaticSnapshotForMobile_RoadCoreUSFS/FeatureServer/2/query';

const ROAD_FETCH_TIMEOUT_MS = 12_000;

interface ArcGisFeatureResult {
  features?: Array<{ attributes: Record<string, unknown> }>;
  error?: { message: string };
}

function geoJsonPolygonToArcGis(geojsonStr: string): { rings: number[][][] } {
  const parsed = JSON.parse(geojsonStr) as { coordinates: number[][][] };
  return { rings: parsed.coordinates };
}

function classifyMtfcc(mtfcc: string): RoadType {
  if (mtfcc === 'S1100') return 'highway';
  if (mtfcc === 'S1200') return 'county';
  if (mtfcc === 'S1400') return 'local';
  if (mtfcc === 'S1500') return 'trail';
  return 'unknown';
}

function normalizeSurface(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const s = raw.trim().toLowerCase();
  if (s.includes('paved') || s.includes('asphalt') || s.includes('concrete')) return 'paved';
  if (s.includes('gravel') || s.includes('crushed')) return 'gravel';
  if (s.includes('dirt') || s.includes('natural') || s.includes('native')) return 'dirt';
  return raw.trim();
}

async function fetchArcGis(url: string, params: URLSearchParams): Promise<ArcGisFeatureResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROAD_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?${params}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json() as ArcGisFeatureResult;
  } finally {
    clearTimeout(timer);
  }
}

async function queryTigerRoads(geomStr: string): Promise<RoadSegment[]> {
  const base = {
    geometry: geomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'NAME,MTFCC',
    resultRecordCount: '50',
    returnGeometry: 'false',
    f: 'json',
  };

  const [secondaryRes, localRes] = await Promise.allSettled([
    fetchArcGis(TIGER_SECONDARY_URL, new URLSearchParams({ ...base, where: "MTFCC IN ('S1100','S1200')" })),
    fetchArcGis(TIGER_LOCAL_URL, new URLSearchParams({ ...base, where: "MTFCC IN ('S1400','S1500')" })),
  ]);

  const features = [
    ...(secondaryRes.status === 'fulfilled' ? secondaryRes.value.features ?? [] : []),
    ...(localRes.status === 'fulfilled' ? localRes.value.features ?? [] : []),
  ];

  return features.map((f) => ({
    name: (f.attributes.NAME as string | null) || null,
    type: classifyMtfcc(f.attributes.MTFCC as string ?? ''),
    source: 'tiger' as const,
    surfaceType: null,
    maintLevel: null,
  }));
}

async function queryBlmRoads(geomStr: string): Promise<RoadSegment[]> {
  const params = new URLSearchParams({
    geometry: geomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'ROUTE_NAME,ROUTE_TYPE,SURFACE_TYPE',
    resultRecordCount: '30',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(BLM_URL, params);

  return (data.features ?? []).map((f) => {
    const routeType = ((f.attributes.ROUTE_TYPE as string) ?? '').toUpperCase();
    let type: RoadType = 'blm';
    if (routeType.includes('PRIM') || routeType === 'P') type = 'trail';
    else if (routeType.includes('4WD') || routeType.includes('UNIMPROVED')) type = 'trail';

    return {
      name: (f.attributes.ROUTE_NAME as string | null) || null,
      type,
      source: 'blm' as const,
      surfaceType: normalizeSurface(f.attributes.SURFACE_TYPE),
      maintLevel: null,
    };
  });
}

async function queryUsfsRoads(geomStr: string): Promise<RoadSegment[]> {
  const params = new URLSearchParams({
    geometry: geomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'NAME,OPER_MAINT_LEVEL,SURFACE_TYPE',
    resultRecordCount: '30',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(USFS_URL, params);

  return (data.features ?? []).map((f) => {
    const level = typeof f.attributes.OPER_MAINT_LEVEL === 'number'
      ? f.attributes.OPER_MAINT_LEVEL as number
      : parseInt(String(f.attributes.OPER_MAINT_LEVEL ?? ''), 10) || null;

    // 1–2: high-clearance/closed → trail; 3–5: passenger vehicles → forest
    const type: RoadType = level != null && level >= 3 ? 'forest' : 'trail';

    return {
      name: (f.attributes.NAME as string | null) || null,
      type,
      source: 'usfs' as const,
      surfaceType: normalizeSurface(f.attributes.SURFACE_TYPE),
      maintLevel: level,
    };
  });
}

function dedupeRoads(segments: RoadSegment[]): RoadSegment[] {
  const seen = new Set<string>();
  return segments.filter((s) => {
    const key = `${s.source}:${s.type}:${(s.name ?? '').toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getRoadAccess(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  const forceRefresh = event.queryStringParameters?.refresh === 'true';

  // Check cache
  const cached = await queryOne<{ roads: string; fetched_at: string }>(
    'SELECT roads::text, fetched_at::text FROM road_access_cache WHERE parcel_id = $1::uuid',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!forceRefresh && cacheAge <= ROAD_ACCESS_TTL_MS && cached) {
    const segments: RoadSegment[] = JSON.parse(cached.roads) as RoadSegment[];
    const result: RoadAccess = {
      parcelId,
      segments,
      hasPublicAccess: segments.some((s) => ['highway', 'county', 'local', 'forest', 'blm'].includes(s.type)),
      fetchedAt: cached.fetched_at,
    };
    metrics.addMetric('RoadAccessCacheHit', MetricUnit.Count, 1);
    return success(result);
  }

  // Buffer boundary by 150 m; for point-only parcels use 400 m since the point
  // may be a centroid far from the road edge on larger rural parcels.
  const geomRow = await queryOne<{ search_geom: string | null }>(
    `SELECT ST_AsGeoJSON(
       ST_Transform(
         ST_Buffer(
           ST_Transform(
             COALESCE(
               boundary::geometry,
               ST_SetSRID(ST_MakePoint(ST_X(coordinates::geometry), ST_Y(coordinates::geometry)), 4326)
             ),
             32612  -- UTM zone 12N, meters
           ),
           CASE WHEN boundary IS NOT NULL THEN 150 ELSE 400 END
         ),
         4326
       )
     )::text AS search_geom
     FROM parcels WHERE id = $1::uuid`,
    [parcelId]
  );

  if (!geomRow?.search_geom) {
    return success({ parcelId, segments: [], hasPublicAccess: false, fetchedAt: new Date().toISOString() } as RoadAccess);
  }

  const arcGisGeomStr = JSON.stringify(geoJsonPolygonToArcGis(geomRow.search_geom));

  const [tigerRes, blmRes, usfsRes] = await Promise.allSettled([
    queryTigerRoads(arcGisGeomStr),
    queryBlmRoads(arcGisGeomStr),
    queryUsfsRoads(arcGisGeomStr),
  ]);

  if (tigerRes.status === 'rejected')
    logger.warn('TIGER road query failed', { error: String(tigerRes.reason) });
  if (blmRes.status === 'rejected')
    logger.warn('BLM road query failed', { error: String(blmRes.reason) });
  if (usfsRes.status === 'rejected')
    logger.warn('USFS road query failed', { error: String(usfsRes.reason) });

  const allFailed =
    tigerRes.status === 'rejected' &&
    blmRes.status === 'rejected' &&
    usfsRes.status === 'rejected';

  const rawSegments: RoadSegment[] = [
    ...(tigerRes.status === 'fulfilled' ? tigerRes.value : []),
    ...(blmRes.status === 'fulfilled' ? blmRes.value : []),
    ...(usfsRes.status === 'fulfilled' ? usfsRes.value : []),
  ];

  const segments = dedupeRoads(rawSegments);
  const fetchedAt = new Date().toISOString();
  const hasPublicAccess = segments.some((s) =>
    ['highway', 'county', 'local', 'forest', 'blm'].includes(s.type)
  );

  // Only cache when at least one source responded — caching an all-failed empty
  // result would suppress the "no roads" warning for 30 days on a transient outage.
  if (!allFailed) {
    await execute(
      `INSERT INTO road_access_cache (parcel_id, roads, fetched_at)
       VALUES ($1::uuid, $2::jsonb, NOW())
       ON CONFLICT (parcel_id) DO UPDATE SET roads = EXCLUDED.roads, fetched_at = NOW()`,
      [parcelId, JSON.stringify(segments)]
    );
  }

  metrics.addMetric('RoadAccessFetched', MetricUnit.Count, 1);
  return success({ parcelId, segments, hasPublicAccess, fetchedAt } as RoadAccess);
}

// ---------------------------------------------------------------------------
// Utilities & Grid Access
// ---------------------------------------------------------------------------

const UTILITY_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HIFLD_TRANSMISSION_URL =
  'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query';
const HIFLD_SERVICE_TERRITORY_URL =
  'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Retail_Service_Territories/FeatureServer/0/query';
const FCC_BROADBAND_URL = 'https://broadbandmap.fcc.gov/api/public/map/listAvailability';
const ELECTRIC_SEARCH_RADIUS_METERS = 16_093; // 10 miles
const UTILITY_FETCH_TIMEOUT_MS = 12_000;

const TECH_CODE_LABELS: Record<number, string> = {
  10: 'DSL',
  11: 'DSL',
  12: 'DSL',
  20: 'Cable',
  30: 'Cable',
  40: 'Cable',
  50: 'Fiber',
  60: 'Satellite',
  70: 'Satellite',
  300: 'Fixed Wireless',
  400: 'Fixed Wireless',
  0: 'Other',
};

interface FccAvailabilityResponse {
  availability?: Array<{
    brand_name?: string;
    doing_business_as?: string;
    frn?: string;
    technology?: number;
    max_advertised_download_speed?: number;
    max_advertised_upload_speed?: number;
  }>;
}

async function fetchFccBroadband(lat: number, lon: number): Promise<BroadbandProvider[]> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(6),
    longitude: lon.toFixed(6),
    unit: '1',
    radius: '0.5',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UTILITY_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${FCC_BROADBAND_URL}?${params}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`FCC BDC HTTP ${res.status}`);

    const data = await res.json() as FccAvailabilityResponse;
    const seen = new Set<string>();
    const providers: BroadbandProvider[] = [];

    for (const entry of data.availability ?? []) {
      const name = entry.brand_name ?? entry.doing_business_as ?? 'Unknown Provider';
      const tech = entry.technology ?? 0;
      const key = `${name}:${tech}`;
      if (seen.has(key)) continue;
      seen.add(key);
      providers.push({
        providerName: name,
        techType: TECH_CODE_LABELS[tech] ?? 'Other',
        maxDownloadSpeed: entry.max_advertised_download_speed ?? null,
        maxUploadSpeed: entry.max_advertised_upload_speed ?? null,
      });
    }

    return providers.sort((a, b) => (b.maxDownloadSpeed ?? 0) - (a.maxDownloadSpeed ?? 0));
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHifldElectricLines(arcGisGeomStr: string): Promise<ElectricAccess> {
  const params = new URLSearchParams({
    geometry: arcGisGeomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'VOLTAGE,VOLT_CLASS,TYPE,OWNER',
    resultRecordCount: '10',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(HIFLD_TRANSMISSION_URL, params);
  const features = data.features ?? [];

  if (features.length === 0) {
    return { hasNearbyLine: false, nearestLineDistanceMiles: null, voltageClass: null, type: null, owner: null, serviceTerritory: null };
  }

  const first = features[0]!.attributes;
  const voltageClass = typeof first.VOLT_CLASS === 'string' && first.VOLT_CLASS
    ? (first.VOLT_CLASS as string).trim()
    : null;
  const type = typeof first.TYPE === 'string' && first.TYPE
    ? (first.TYPE as string).trim()
    : null;
  const owner = typeof first.OWNER === 'string' && first.OWNER
    ? (first.OWNER as string).trim()
    : null;

  return { hasNearbyLine: true, nearestLineDistanceMiles: null, voltageClass, type, owner, serviceTerritory: null };
}

async function fetchHifldServiceTerritory(
  lat: number,
  lon: number
): Promise<{ utilityName: string; utilityType: string | null } | null> {
  const params = new URLSearchParams({
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'NAME,TYPE',
    resultRecordCount: '1',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(HIFLD_SERVICE_TERRITORY_URL, params);
  const feature = (data.features ?? [])[0];
  if (!feature) return null;

  const name = typeof feature.attributes.NAME === 'string' && feature.attributes.NAME
    ? (feature.attributes.NAME as string).trim()
    : null;
  if (!name) return null;

  const type = typeof feature.attributes.TYPE === 'string' && feature.attributes.TYPE
    ? (feature.attributes.TYPE as string).trim()
    : null;

  return { utilityName: name, utilityType: type };
}

async function getUtilities(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  const forceRefresh = event.queryStringParameters?.refresh === 'true';

  const cached = await queryOne<{ electric: string | null; broadband: string; fetched_at: string }>(
    'SELECT electric::text, broadband::text, fetched_at::text FROM utility_access_cache WHERE parcel_id = $1::uuid',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!forceRefresh && cacheAge <= UTILITY_ACCESS_TTL_MS && cached) {
    const result: UtilityAccess = {
      parcelId,
      electric: cached.electric ? JSON.parse(cached.electric) as ElectricAccess : null,
      broadband: JSON.parse(cached.broadband) as BroadbandProvider[],
      fetchedAt: cached.fetched_at,
    };
    metrics.addMetric('UtilityAccessCacheHit', MetricUnit.Count, 1);
    return success(result);
  }

  // Get parcel geometry and centroid
  const geomRow = await queryOne<{ search_geom: string | null; lat: number | null; lon: number | null }>(
    `SELECT
       ST_AsGeoJSON(
         ST_Transform(
           ST_Buffer(
             ST_Transform(
               COALESCE(
                 boundary::geometry,
                 ST_SetSRID(ST_MakePoint(ST_X(coordinates::geometry), ST_Y(coordinates::geometry)), 4326)
               ),
               32612
             ),
             $2
           ),
           4326
         )
       )::text AS search_geom,
       ST_Y(coordinates::geometry) AS lat,
       ST_X(coordinates::geometry) AS lon
     FROM parcels WHERE id = $1::uuid`,
    [parcelId, ELECTRIC_SEARCH_RADIUS_METERS]
  );

  if (!geomRow?.search_geom) {
    return success({ parcelId, electric: null, broadband: [], fetchedAt: new Date().toISOString() } as UtilityAccess);
  }

  const arcGisGeomStr = JSON.stringify(geoJsonPolygonToArcGis(geomRow.search_geom));

  const [electricRes, broadbandRes, serviceTerritoryRes] = await Promise.allSettled([
    fetchHifldElectricLines(arcGisGeomStr),
    geomRow.lat != null && geomRow.lon != null
      ? fetchFccBroadband(geomRow.lat, geomRow.lon)
      : Promise.resolve([] as BroadbandProvider[]),
    geomRow.lat != null && geomRow.lon != null
      ? fetchHifldServiceTerritory(geomRow.lat, geomRow.lon)
      : Promise.resolve(null),
  ]);

  if (electricRes.status === 'rejected')
    logger.warn('HIFLD electric line query failed', { error: String(electricRes.reason) });
  if (broadbandRes.status === 'rejected')
    logger.warn('FCC broadband query failed', { error: String(broadbandRes.reason) });
  if (serviceTerritoryRes.status === 'rejected')
    logger.warn('HIFLD service territory query failed', { error: String(serviceTerritoryRes.reason) });

  let electric = electricRes.status === 'fulfilled' ? electricRes.value : null;
  if (electric && serviceTerritoryRes.status === 'fulfilled') {
    electric = { ...electric, serviceTerritory: serviceTerritoryRes.value };
  } else if (electric == null && serviceTerritoryRes.status === 'fulfilled' && serviceTerritoryRes.value) {
    electric = {
      hasNearbyLine: false,
      nearestLineDistanceMiles: null,
      voltageClass: null,
      type: null,
      owner: null,
      serviceTerritory: serviceTerritoryRes.value,
    };
  }
  const broadband = broadbandRes.status === 'fulfilled' ? broadbandRes.value : [];
  const fetchedAt = new Date().toISOString();

  const allFailed = electricRes.status === 'rejected' && broadbandRes.status === 'rejected' && serviceTerritoryRes.status === 'rejected';

  if (!allFailed) {
    await execute(
      `INSERT INTO utility_access_cache (parcel_id, electric, broadband, fetched_at)
       VALUES ($1::uuid, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (parcel_id) DO UPDATE SET electric = EXCLUDED.electric, broadband = EXCLUDED.broadband, fetched_at = NOW()`,
      [parcelId, electric ? JSON.stringify(electric) : null, JSON.stringify(broadband)]
    );
  }

  metrics.addMetric('UtilityAccessFetched', MetricUnit.Count, 1);
  return success({ parcelId, electric, broadband, fetchedAt } as UtilityAccess);
}

// ---------------------------------------------------------------------------
// Environmental & Risk
// ---------------------------------------------------------------------------

const ENV_RISK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// FEMA National Flood Hazard Layer — Flood Hazard Zones (S_Fld_Haz_Ar, layer 28)
const FEMA_NFHL_URL =
  'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
// FEMA National Risk Index — census-tract wildfire risk scores
const FEMA_NRI_URL =
  'https://services.arcgis.com/XG15caxAWkAJOxhH/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0/query';
// USGS Mineral Resources Data System — mine site locations
const USGS_MRDS_URL =
  'https://mrdata.usgs.gov/arcgis/rest/services/MRDS/MapServer/0/query';

const MINE_SEARCH_RADIUS_METERS = 16_093; // 10 miles

const MODERATE_ZONES = new Set(['B','X500']);

function classifyFloodZone(zone: string): FloodRiskLevel {
  const z = zone.trim().toUpperCase();
  if (z === 'X' || z === 'C') return 'minimal';
  if (MODERATE_ZONES.has(z)) return 'moderate';
  if (z === 'D') return 'undetermined';
  // AE, A*, VE, V* and any other lettered SFHA zones
  if (z.startsWith('A') || z.startsWith('V')) return 'high';
  return 'undetermined';
}

async function fetchFloodZones(arcGisGeomStr: string): Promise<FloodZone[]> {
  const params = new URLSearchParams({
    geometry: arcGisGeomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
    resultRecordCount: '20',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(FEMA_NFHL_URL, params);

  const seen = new Set<string>();
  const zones: FloodZone[] = [];

  for (const f of data.features ?? []) {
    const zone = (f.attributes.FLD_ZONE as string | null)?.trim() ?? 'UNKNOWN';
    const subtype = (f.attributes.ZONE_SUBTY as string | null)?.trim() || null;
    const key = `${zone}:${subtype ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const sfha = String(f.attributes.SFHA_TF ?? '').toUpperCase() === 'T';
    zones.push({
      zone,
      subtype,
      isSpecialFloodHazardArea: sfha,
      riskLevel: classifyFloodZone(zone),
    });
  }

  return zones.sort((a, b) => {
    const order: FloodRiskLevel[] = ['high', 'moderate', 'undetermined', 'minimal'];
    return order.indexOf(a.riskLevel) - order.indexOf(b.riskLevel);
  });
}

async function fetchWildfireRisk(lat: number, lon: number): Promise<WildfireRiskRating | null> {
  const pointGeom = JSON.stringify({ x: lon, y: lat });
  const params = new URLSearchParams({
    geometry: pointGeom,
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelWithin',
    inSR: '4326',
    outFields: 'WFIR_RISKR',
    resultRecordCount: '1',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(FEMA_NRI_URL, params);
  const raw = data.features?.[0]?.attributes?.WFIR_RISKR;

  if (typeof raw !== 'string' || !raw || raw === 'No Rating') return null;
  const valid: WildfireRiskRating[] = ['Very High', 'High', 'Medium', 'Low', 'Very Low'];
  return valid.find((r) => raw.trim() === r) ?? null;
}

async function fetchMineSites(arcGisGeomStr: string): Promise<MineSite[]> {
  const params = new URLSearchParams({
    geometry: arcGisGeomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'SITE_NAME,DEP_TYPE,WORK_TYPE,OPER_TYPE',
    resultRecordCount: '20',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(USGS_MRDS_URL, params);

  return (data.features ?? []).map((f) => ({
    name: (f.attributes.SITE_NAME as string | null) || null,
    depositType: (f.attributes.DEP_TYPE as string | null) || null,
    workType: (f.attributes.WORK_TYPE as string | null) || null,
    operType: (f.attributes.OPER_TYPE as string | null) || null,
  }));
}

async function getEnvironmentalRisk(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  const forceRefresh = event.queryStringParameters?.refresh === 'true';

  const cached = await queryOne<{
    flood_zones: string;
    wildfire_risk: string | null;
    mine_sites: string;
    fetched_at: string;
  }>(
    'SELECT flood_zones::text, wildfire_risk, mine_sites::text, fetched_at::text FROM environmental_risk_cache WHERE parcel_id = $1::uuid',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!forceRefresh && cacheAge <= ENV_RISK_TTL_MS && cached) {
    const result: EnvironmentalRisk = {
      parcelId,
      floodZones: JSON.parse(cached.flood_zones) as FloodZone[],
      wildfireRisk: (cached.wildfire_risk as WildfireRiskRating | null) ?? null,
      mineSites: JSON.parse(cached.mine_sites) as MineSite[],
      fetchedAt: cached.fetched_at,
    };
    metrics.addMetric('EnvRiskCacheHit', MetricUnit.Count, 1);
    return success(result);
  }

  // Build buffered geometry for flood/mine queries and get centroid for wildfire
  const geomRow = await queryOne<{
    flood_geom: string | null;
    mine_geom: string | null;
    lat: number | null;
    lon: number | null;
  }>(
    `SELECT
       ST_AsGeoJSON(
         ST_Transform(
           ST_Buffer(ST_Transform(
             COALESCE(boundary::geometry, ST_SetSRID(ST_MakePoint(ST_X(coordinates::geometry), ST_Y(coordinates::geometry)), 4326)),
             32612
           ), CASE WHEN boundary IS NOT NULL THEN 50 ELSE 200 END),
           4326
         )
       )::text AS flood_geom,
       ST_AsGeoJSON(
         ST_Transform(
           ST_Buffer(ST_Transform(
             COALESCE(boundary::geometry, ST_SetSRID(ST_MakePoint(ST_X(coordinates::geometry), ST_Y(coordinates::geometry)), 4326)),
             32612
           ), $2),
           4326
         )
       )::text AS mine_geom,
       ST_Y(coordinates::geometry) AS lat,
       ST_X(coordinates::geometry) AS lon
     FROM parcels WHERE id = $1::uuid`,
    [parcelId, MINE_SEARCH_RADIUS_METERS]
  );

  if (!geomRow?.flood_geom) {
    return success({ parcelId, floodZones: [], wildfireRisk: null, mineSites: [], fetchedAt: new Date().toISOString() } as EnvironmentalRisk);
  }

  const floodGeomStr = JSON.stringify(geoJsonPolygonToArcGis(geomRow.flood_geom));
  const mineGeomStr = geomRow.mine_geom
    ? JSON.stringify(geoJsonPolygonToArcGis(geomRow.mine_geom))
    : floodGeomStr;

  const [floodRes, wildfireRes, mineRes] = await Promise.allSettled([
    fetchFloodZones(floodGeomStr),
    geomRow.lat != null && geomRow.lon != null
      ? fetchWildfireRisk(geomRow.lat, geomRow.lon)
      : Promise.resolve(null as WildfireRiskRating | null),
    fetchMineSites(mineGeomStr),
  ]);

  if (floodRes.status === 'rejected')
    logger.warn('FEMA NFHL flood query failed', { error: String(floodRes.reason) });
  if (wildfireRes.status === 'rejected')
    logger.warn('FEMA NRI wildfire query failed', { error: String(wildfireRes.reason) });
  if (mineRes.status === 'rejected')
    logger.warn('USGS MRDS mine query failed', { error: String(mineRes.reason) });

  const allFailed =
    floodRes.status === 'rejected' &&
    wildfireRes.status === 'rejected' &&
    mineRes.status === 'rejected';

  const floodZones = floodRes.status === 'fulfilled' ? floodRes.value : [];
  const wildfireRisk = wildfireRes.status === 'fulfilled' ? wildfireRes.value : null;
  const mineSites = mineRes.status === 'fulfilled' ? mineRes.value : [];
  const fetchedAt = new Date().toISOString();

  if (!allFailed) {
    await execute(
      `INSERT INTO environmental_risk_cache (parcel_id, flood_zones, wildfire_risk, mine_sites, fetched_at)
       VALUES ($1::uuid, $2::jsonb, $3, $4::jsonb, NOW())
       ON CONFLICT (parcel_id) DO UPDATE
         SET flood_zones = EXCLUDED.flood_zones,
             wildfire_risk = EXCLUDED.wildfire_risk,
             mine_sites = EXCLUDED.mine_sites,
             fetched_at = NOW()`,
      [parcelId, JSON.stringify(floodZones), wildfireRisk, JSON.stringify(mineSites)]
    );
  }

  metrics.addMetric('EnvRiskFetched', MetricUnit.Count, 1);
  return success({ parcelId, floodZones, wildfireRisk, mineSites, fetchedAt } as EnvironmentalRisk);
}

// ---------------------------------------------------------------------------

const INSIGHT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function getInsights(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) {
    return badRequest('Parcel ID is required');
  }

  const insightSql = `
    SELECT
      id,
      parcel_id,
      insight_type,
      content,
      model_version,
      created_at
    FROM parcel_insights
    WHERE parcel_id = $1::uuid
    ORDER BY created_at DESC
  `;

  let rows = await query<InsightRow>(insightSql, [parcelId]);

  const latestSummary = rows.find((r) => r.insight_type === 'summary');
  const summaryAge = latestSummary
    ? Date.now() - new Date(latestSummary.created_at).getTime()
    : Infinity;

  if (summaryAge <= INSIGHT_TTL_MS) {
    metrics.addMetric('InsightCacheHit', MetricUnit.Count, 1);
    logger.info('Serving cached insight', { parcelId, ageMs: summaryAge });
  } else {
    const parcelSql = `SELECT county, acreage, address FROM parcels WHERE id = $1::uuid`;
    const parcelRow = await queryOne<Pick<ParcelRow, 'county' | 'acreage' | 'address'>>(
      parcelSql,
      [parcelId]
    );

    if (parcelRow) {
      try {
        const [wrRows, roadCached, utilityCached, envCached, easementCached] = await Promise.all([
          query<Pick<WaterRightRow, 'water_source' | 'water_type' | 'flow_rate' | 'volume' | 'priority_date' | 'status'>>(
            `SELECT water_source, water_type, flow_rate, volume, priority_date, status
             FROM water_rights WHERE parcel_id = $1::uuid ORDER BY priority_date ASC`,
            [parcelId]
          ),
          queryOne<{ roads: string }>('SELECT roads::text FROM road_access_cache WHERE parcel_id = $1::uuid', [parcelId]),
          queryOne<{ electric: string | null; broadband: string }>('SELECT electric::text, broadband::text FROM utility_access_cache WHERE parcel_id = $1::uuid', [parcelId]),
          queryOne<{ flood_zones: string; wildfire_risk: string | null; mine_sites: string }>('SELECT flood_zones::text, wildfire_risk, mine_sites::text FROM environmental_risk_cache WHERE parcel_id = $1::uuid', [parcelId]),
          queryOne<{ easements: string }>('SELECT easements::text FROM conservation_easement_cache WHERE parcel_id = $1::uuid', [parcelId]),
        ]);

        const roadSegments: RoadSegment[] = roadCached ? JSON.parse(roadCached.roads) as RoadSegment[] : [];
        const electric: ElectricAccess | null = utilityCached?.electric ? JSON.parse(utilityCached.electric) as ElectricAccess : null;
        const broadband: BroadbandProvider[] = utilityCached ? JSON.parse(utilityCached.broadband) as BroadbandProvider[] : [];
        const floodZones: FloodZone[] = envCached ? JSON.parse(envCached.flood_zones) as FloodZone[] : [];
        const easements: ConservationEasement[] = easementCached ? JSON.parse(easementCached.easements) as ConservationEasement[] : [];
        const mineSites: MineSite[] = envCached ? JSON.parse(envCached.mine_sites) as MineSite[] : [];

        logger.info('Generating insight via Bedrock', { parcelId, modelId: BEDROCK_MODEL_ID });
        const bedrockStart = Date.now();

        const content = await generateBuildabilitySummary({
          county: parcelRow.county,
          acreage: parcelRow.acreage,
          address: parcelRow.address,
          waterRights: wrRows.map((wr) => ({
            waterSource: wr.water_source,
            waterType: wr.water_type,
            flowRate: wr.flow_rate,
            volume: wr.volume,
            priorityDate: wr.priority_date,
            status: wr.status ?? 'unknown',
          })),
          roadAccess: roadCached
            ? {
                hasPublicAccess: roadSegments.some((s) => ['highway', 'county', 'local', 'forest', 'blm'].includes(s.type)),
                roadTypes: [...new Set(roadSegments.map((s) => s.type))],
              }
            : null,
          electric: electric
            ? {
                hasServiceTerritory: electric.serviceTerritory != null,
                utilityName: electric.serviceTerritory?.utilityName ?? null,
                hasNearbyLine: electric.hasNearbyLine,
              }
            : null,
          broadband: broadband.map((b) => ({ techType: b.techType, maxDownloadSpeed: b.maxDownloadSpeed })),
          floodZones: floodZones.map((z) => ({ zone: z.zone, isSpecialFloodHazardArea: z.isSpecialFloodHazardArea, riskLevel: z.riskLevel })),
          wildfireRisk: envCached?.wildfire_risk ?? null,
          mineSiteCount: mineSites.length,
          conservationEasements: easements.map((e) => ({ holderName: e.holderName, restrictions: e.restrictions })),
        });

        const bedrockDurationMs = Date.now() - bedrockStart;
        metrics.addMetric('InsightGenerated', MetricUnit.Count, 1);
        metrics.addMetric('BedrockCallLatency', MetricUnit.Milliseconds, bedrockDurationMs);
        logger.info('Insight generated', { parcelId, bedrockDurationMs });

        const newRows = await query<InsightRow>(
          `INSERT INTO parcel_insights (parcel_id, insight_type, content, model_version)
           VALUES ($1::uuid, $2, $3, $4)
           RETURNING id, parcel_id, insight_type, content, model_version, created_at`,
          [parcelId, 'summary', content, BEDROCK_MODEL_ID]
        );
        if (newRows[0]) rows = [newRows[0], ...rows];
      } catch (bedrockErr) {
        logger.warn('Bedrock insight generation failed, returning empty insights', {
          parcelId,
          error: bedrockErr instanceof Error ? bedrockErr.message : String(bedrockErr),
        });
      }
    }
  }

  const insights: ParcelInsight[] = rows.map((row) => ({
    id: row.id,
    parcelId: row.parcel_id,
    insightType: row.insight_type as ParcelInsight['insightType'],
    content: row.content,
    modelVersion: row.model_version,
    createdAt: row.created_at,
  }));

  return success(insights);
}

// ---------------------------------------------------------------------------
// Listing Status (Claude web-search "is this for sale" check)
// ---------------------------------------------------------------------------

async function getListingStatus(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  const forceRefresh = event.queryStringParameters?.refresh === 'true';

  const parcelRow = await queryOne<{ parcel_number: string | null; address: string | null }>(
    'SELECT parcel_number, address FROM parcels WHERE id = $1::uuid',
    [parcelId]
  );
  if (!parcelRow) return notFound('Parcel not found');

  if (!parcelRow.parcel_number || !parcelRow.address) {
    const result: ListingStatus = {
      parcelId,
      forSale: false,
      confidence: 'low',
      price: null,
      listingUrl: null,
      source: null,
      summary: 'No address on file for this parcel.',
      fetchedAt: new Date().toISOString(),
    };
    return success(result);
  }

  const checked = await getOrCheckListingStatus(parcelRow.parcel_number, parcelRow.address, { forceRefresh });
  if (!checked) {
    return errorResponse(503, 'LISTING_CHECK_FAILED', 'Could not check listing status right now. Please try again.');
  }

  metrics.addMetric('ListingStatusChecked', MetricUnit.Count, 1);

  const result: ListingStatus = {
    parcelId,
    forSale: checked.forSale,
    confidence: checked.confidence,
    price: checked.price,
    listingUrl: checked.listingUrl,
    source: checked.source,
    summary: checked.summary,
    fetchedAt: checked.fetchedAt,
  };
  return success(result);
}

// ---------------------------------------------------------------------------
// Conservation Easements
// ---------------------------------------------------------------------------

const CONSERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// National Conservation Easement Database via ESRI ArcGIS Online
const NCED_URL =
  'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Conservation_Easements_WFL1/FeatureServer/0/query';

async function getConservationEasements(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const parcelId = event.pathParameters?.id;
  if (!parcelId) return badRequest('Parcel ID is required');

  const forceRefresh = event.queryStringParameters?.refresh === 'true';

  const cached = await queryOne<{ easements: string; fetched_at: string }>(
    'SELECT easements::text, fetched_at::text FROM conservation_easement_cache WHERE parcel_id = $1::uuid',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!forceRefresh && cacheAge <= CONSERVATION_TTL_MS && cached) {
    return success(JSON.parse(cached.easements) as ConservationEasement[]);
  }

  const coordRow = await queryOne<{ lat: number | null; lon: number | null }>(
    'SELECT ST_Y(coordinates::geometry) AS lat, ST_X(coordinates::geometry) AS lon FROM parcels WHERE id = $1::uuid',
    [parcelId]
  );

  if (!coordRow?.lat || !coordRow?.lon) {
    return success([] as ConservationEasement[]);
  }

  const { lat, lon } = coordRow;
  const pad = 0.05; // ~3 miles envelope around parcel centroid
  const params = new URLSearchParams({
    geometry: `${lon - pad},${lat - pad},${lon + pad},${lat + pad}`,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    outFields: 'holderName,purpose,dateRecorded,restrictions,gisAcres',
    resultRecordCount: '20',
    returnGeometry: 'false',
    f: 'json',
  });

  let easements: ConservationEasement[] = [];
  try {
    const data = await fetchArcGis(NCED_URL, params);
    easements = (data.features ?? []).map((f) => ({
      holderName: (f.attributes.holderName as string | null) || null,
      purpose: (f.attributes.purpose as string | null) || null,
      dateRecorded: (f.attributes.dateRecorded as string | null) || null,
      restrictions: (f.attributes.restrictions as string | null) || null,
      acreage: typeof f.attributes.gisAcres === 'number' ? Math.round(f.attributes.gisAcres) : null,
    }));
  } catch (err) {
    logger.warn('Conservation easement fetch failed', { error: String(err) });
  }

  await execute(
    `INSERT INTO conservation_easement_cache (parcel_id, easements, fetched_at)
     VALUES ($1::uuid, $2::jsonb, NOW())
     ON CONFLICT (parcel_id) DO UPDATE SET easements = EXCLUDED.easements, fetched_at = NOW()`,
    [parcelId, JSON.stringify(easements)]
  );

  return success(easements);
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    const { httpMethod, path } = event;

    if (httpMethod !== 'GET') {
      return badRequest('Method not allowed');
    }

    if (path.endsWith('/water-rights')) {
      return await getWaterRights(event);
    }

    if (path.endsWith('/listings')) {
      return await getListings(event);
    }

    if (path.endsWith('/insights')) {
      return await getInsights(event);
    }

    if (path.endsWith('/hunting-districts')) {
      return await getHuntingDistricts(event);
    }

    if (path.endsWith('/stream-gauges')) {
      return await getStreamGauges(event);
    }

    if (path.endsWith('/road-access')) {
      return await getRoadAccess(event);
    }

    if (path.endsWith('/utilities')) {
      return await getUtilities(event);
    }

    if (path.endsWith('/environmental-risk')) {
      return await getEnvironmentalRisk(event);
    }

    if (path.endsWith('/conservation-easements')) {
      return await getConservationEasements(event);
    }

    if (path.endsWith('/listing-status')) {
      return await getListingStatus(event);
    }

    if (path.endsWith('/soil')) {
      const parcelId = event.pathParameters?.id;
      if (!parcelId) return badRequest('Parcel ID is required');
      const result = await getSoilInfo(parcelId, {
        forceRefresh: event.queryStringParameters?.refresh === 'true',
      });
      if (!result) return notFound('Soil data unavailable for this parcel');
      return success(result);
    }

    if (path.endsWith('/groundwater')) {
      const parcelId = event.pathParameters?.id;
      if (!parcelId) return badRequest('Parcel ID is required');
      const radiusParam = event.queryStringParameters?.radius;
      const radiusMiles = radiusParam ? Number(radiusParam) : undefined;
      const result = await getGroundwater(parcelId, {
        forceRefresh: event.queryStringParameters?.refresh === 'true',
        radiusMiles: radiusMiles && Number.isFinite(radiusMiles) ? radiusMiles : undefined,
      });
      if (!result) return notFound('Groundwater data unavailable for this parcel');
      return success(result);
    }

    return await getParcel(event);
  } catch (err) {
    logger.error('Unhandled parcel handler error', { error: err instanceof Error ? err.message : String(err) });
    return serverError('An error occurred fetching parcel data');
  } finally {
    metrics.publishStoredMetrics();
  }
}
