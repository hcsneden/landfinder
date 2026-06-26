import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { query, queryOne, execute } from '../shared/db';
import { success, badRequest, notFound, serverError } from '../shared/response';
import { generateBuildabilitySummary, BEDROCK_MODEL_ID } from '../shared/bedrock';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import type { Parcel, WaterRight, Listing, ParcelInsight, HuntingDistrict, StreamGauge, StreamGaugeReading, RoadSegment, RoadAccess, RoadType } from '@landfinder/shared';

interface ParcelRow {
  id: string;
  state: string;
  county: string | null;
  parcel_number: string | null;
  geo_id: string | null;
  address: string | null;
  acreage: number | null;
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
      ST_X(coordinates::geometry) as longitude,
      ST_Y(coordinates::geometry) as latitude,
      ST_AsGeoJSON(boundary)::text as boundary,
      created_at,
      updated_at
    FROM parcels
    WHERE id = $1
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
    WHERE parcel_id = $1
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
    WHERE parcel_id = $1
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
    JOIN parcels p ON p.id = $1
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
  for (const r of readings) {
    await execute(
      `INSERT INTO stream_gauge_readings (gauge_id, reading_date, mean_flow_cfs, fetched_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (gauge_id, reading_date)
       DO UPDATE SET mean_flow_cfs = EXCLUDED.mean_flow_cfs, fetched_at = NOW()`,
      [gaugeId, r.date, r.cfs]
    );
  }
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
     JOIN parcels p ON p.id = $1
     WHERE ST_DWithin(sg.coordinates, p.coordinates, $2)
     ORDER BY distance_miles
     LIMIT $3`,
    [parcelId, GAUGE_SEARCH_RADIUS_METERS, MAX_NEARBY_GAUGES]
  );

  if (gaugeRows.length === 0) {
    return success([]);
  }

  const result: StreamGauge[] = [];

  for (const gauge of gaugeRows) {
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
       WHERE gauge_id = $1
       ORDER BY reading_date DESC
       LIMIT 365`,
      [gauge.id]
    );

    const readings: StreamGaugeReading[] = readingRows.map((r) => ({
      date: r.reading_date,
      meanFlowCfs: Number(r.mean_flow_cfs),
    }));

    const latestReading = readings[0] ?? null;

    result.push({
      id: gauge.id,
      siteNumber: gauge.site_number,
      siteName: gauge.site_name,
      streamName: gauge.stream_name,
      distanceMiles: Math.round(gauge.distance_miles * 10) / 10,
      latestFlowCfs: latestReading ? latestReading.meanFlowCfs : null,
      latestReadingDate: latestReading ? latestReading.date : null,
      readings,
      monthlyAveragesCfs: buildMonthlyAverages(readings),
    });
  }

  metrics.addMetric('StreamGaugesFetched', MetricUnit.Count, 1);
  return success(result);
}

// ---------------------------------------------------------------------------
// Road Access
// ---------------------------------------------------------------------------

const ROAD_ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — road networks change rarely

// TIGER/Line EDGES: all road types, filter by MTFCC
const TIGER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/EDGES/MapServer/0/query';
// BLM National Transportation Routes
const BLM_URL = 'https://gis.blm.gov/arcgis/rest/services/Lands_and_Realty/BLM_National_Transportation_Routes/MapServer/0/query';
// USFS Road Core
const USFS_URL = 'https://apps.fs.usda.gov/arcgis/rest/services/EDW/EDW_RoadCore_01/MapServer/0/query';

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
  const params = new URLSearchParams({
    geometry: geomStr,
    geometryType: 'esriGeometryPolygon',
    spatialRel: 'esriSpatialRelIntersects',
    inSR: '4326',
    where: "MTFCC IN ('S1100','S1200','S1400','S1500')",
    outFields: 'FULLNAME,MTFCC',
    resultRecordCount: '50',
    returnGeometry: 'false',
    f: 'json',
  });

  const data = await fetchArcGis(TIGER_URL, params);

  return (data.features ?? []).map((f) => ({
    name: (f.attributes.FULLNAME as string | null) || null,
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

  // Check cache
  const cached = await queryOne<{ roads: string; fetched_at: string }>(
    'SELECT roads::text, fetched_at::text FROM road_access_cache WHERE parcel_id = $1',
    [parcelId]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (cacheAge <= ROAD_ACCESS_TTL_MS && cached) {
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

  // Get parcel geometry — buffer by ~150m to catch adjacent roads
  const geomRow = await queryOne<{ search_geom: string | null }>(
    `SELECT ST_AsGeoJSON(
       ST_Buffer(
         COALESCE(
           boundary::geometry,
           ST_SetSRID(ST_MakePoint(ST_X(coordinates::geometry), ST_Y(coordinates::geometry)), 4326)
         ),
         0.0014  -- ~150 m at Montana latitudes
       )
     )::text AS search_geom
     FROM parcels WHERE id = $1`,
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

  await execute(
    `INSERT INTO road_access_cache (parcel_id, roads, fetched_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (parcel_id) DO UPDATE SET roads = EXCLUDED.roads, fetched_at = NOW()`,
    [parcelId, JSON.stringify(segments)]
  );

  metrics.addMetric('RoadAccessFetched', MetricUnit.Count, 1);
  return success({ parcelId, segments, hasPublicAccess, fetchedAt } as RoadAccess);
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
    WHERE parcel_id = $1
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
    const parcelSql = `SELECT county, acreage, address FROM parcels WHERE id = $1`;
    const parcelRow = await queryOne<Pick<ParcelRow, 'county' | 'acreage' | 'address'>>(
      parcelSql,
      [parcelId]
    );

    if (parcelRow) {
      try {
        const waterRightsSql = `
          SELECT water_source, water_type, flow_rate, volume, priority_date, status
          FROM water_rights
          WHERE parcel_id = $1
          ORDER BY priority_date ASC
        `;
        const wrRows = await query<
          Pick<WaterRightRow, 'water_source' | 'water_type' | 'flow_rate' | 'volume' | 'priority_date' | 'status'>
        >(waterRightsSql, [parcelId]);

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
        });

        const bedrockDurationMs = Date.now() - bedrockStart;
        metrics.addMetric('InsightGenerated', MetricUnit.Count, 1);
        metrics.addMetric('BedrockCallLatency', MetricUnit.Milliseconds, bedrockDurationMs);
        logger.info('Insight generated', { parcelId, bedrockDurationMs });

        await execute(
          `INSERT INTO parcel_insights (parcel_id, insight_type, content, model_version)
           VALUES ($1, $2, $3, $4)`,
          [parcelId, 'summary', content, BEDROCK_MODEL_ID]
        );

        rows = await query<InsightRow>(insightSql, [parcelId]);
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

    return await getParcel(event);
  } catch (err) {
    logger.error('Unhandled parcel handler error', { error: err instanceof Error ? err.message : String(err) });
    return serverError('An error occurred fetching parcel data');
  } finally {
    metrics.publishStoredMetrics();
  }
}
