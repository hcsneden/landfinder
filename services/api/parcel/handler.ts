import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { query, queryOne, execute } from '../shared/db';
import { success, badRequest, notFound, serverError } from '../shared/response';
import { generateBuildabilitySummary, BEDROCK_MODEL_ID } from '../shared/bedrock';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import type { Parcel, WaterRight, Listing, ParcelInsight } from '@landfinder/shared';

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
      ST_AsGeoJSON(boundary)::json as boundary,
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

    return await getParcel(event);
  } catch (err) {
    logger.error('Unhandled parcel handler error', { error: err instanceof Error ? err.message : String(err) });
    return serverError('An error occurred fetching parcel data');
  } finally {
    metrics.publishStoredMetrics();
  }
}
