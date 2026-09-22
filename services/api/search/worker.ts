import type { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { query } from '../shared/db';
import { getListingStatusesForParcels } from '../shared/listingStatus';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import type { SearchCriteria, SearchResult, Parcel, Listing } from '@lastbestland/shared';

const dynamoClient = tracer.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const SEARCHES_TABLE = process.env.SEARCHES_TABLE;
if (!SEARCHES_TABLE) throw new Error('SEARCHES_TABLE environment variable not set');

interface SearchJobMessage {
  searchId: string;
  userId: string;
  criteria: SearchCriteria;
  createdAt: string;
}

async function executeSearch(criteria: SearchCriteria): Promise<SearchResult[]> {
  const conditions: string[] = ['p.state = $1'];
  const params: unknown[] = [criteria.state];
  let paramIndex = 2;

  if (criteria.county) {
    conditions.push(`p.county = $${paramIndex}`);
    params.push(criteria.county);
    paramIndex++;
  }

  if (criteria.minAcreage !== undefined) {
    conditions.push(`p.acreage >= $${paramIndex}`);
    params.push(criteria.minAcreage);
    paramIndex++;
  }

  if (criteria.maxAcreage !== undefined) {
    conditions.push(`p.acreage <= $${paramIndex}`);
    params.push(criteria.maxAcreage);
    paramIndex++;
  }

  if (criteria.minPrice !== undefined) {
    conditions.push(`l.price >= $${paramIndex}`);
    params.push(criteria.minPrice);
    paramIndex++;
  }

  if (criteria.maxPrice !== undefined) {
    conditions.push(`l.price <= $${paramIndex}`);
    params.push(criteria.maxPrice);
    paramIndex++;
  }

  if (criteria.bbox) {
    const { minLng, minLat, maxLng, maxLat } = criteria.bbox;
    conditions.push(
      `ST_Within(p.coordinates::geometry, ST_MakeEnvelope($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, 4326))`
    );
    params.push(minLng, minLat, maxLng, maxLat);
    paramIndex += 4;
  }

  const waterRightsJoin = criteria.waterRightsRequired
    ? 'INNER JOIN water_rights wr ON p.id = wr.parcel_id'
    : 'LEFT JOIN water_rights wr ON p.id = wr.parcel_id';

  const sql = `
    SELECT
      p.id,
      p.state,
      p.county,
      p.parcel_number,
      p.geo_id,
      p.address,
      p.acreage,
      ST_X(p.coordinates::geometry) as longitude,
      ST_Y(p.coordinates::geometry) as latitude,
      p.created_at,
      p.updated_at,
      l.id as listing_id,
      l.source,
      l.source_id,
      l.price,
      l.listing_url,
      l.description,
      l.images,
      l.listed_at,
      CASE WHEN wr.id IS NOT NULL THEN true ELSE false END as has_water_rights,
      pi.content as preview_insight
    FROM parcels p
    LEFT JOIN LATERAL (
      SELECT * FROM listings
      WHERE parcel_id = p.id
      ORDER BY scraped_at DESC
      LIMIT 1
    ) l ON true
    ${waterRightsJoin}
    LEFT JOIN LATERAL (
      SELECT content FROM parcel_insights
      WHERE parcel_id = p.id AND insight_type = 'summary'
      ORDER BY created_at DESC
      LIMIT 1
    ) pi ON true
    WHERE ${conditions.join(' AND ')}
    GROUP BY p.id, l.id, l.source, l.source_id, l.price, l.listing_url,
             l.description, l.images, l.listed_at, wr.id, pi.content
    ORDER BY p.updated_at DESC
    LIMIT 100
  `;

  interface SearchRow {
    id: string;
    state: string;
    county: string | null;
    parcel_number: string | null;
    geo_id: string | null;
    address: string | null;
    acreage: number | null;
    longitude: number | null;
    latitude: number | null;
    created_at: string;
    updated_at: string;
    listing_id: string | null;
    source: string | null;
    source_id: string | null;
    price: number | null;
    listing_url: string | null;
    description: string | null;
    images: string[] | null;
    listed_at: string | null;
    has_water_rights: boolean;
    preview_insight: string | null;
  }

  const rows = await query<SearchRow>(sql, params);

  return rows.map((row): SearchResult => {
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
      boundary: null,
      buildingValue: null,
      propType: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    const listing: Listing | null = row.listing_id
      ? {
          id: row.listing_id,
          parcelId: row.id,
          source: row.source as Listing['source'],
          sourceId: row.source_id || '',
          price: row.price,
          listingUrl: row.listing_url || '',
          description: row.description,
          images: row.images || [],
          listedAt: row.listed_at,
          scrapedAt: row.updated_at,
          rawData: {},
        }
      : null;

    return {
      parcel,
      listing,
      hasWaterRights: row.has_water_rights,
      previewInsight: row.preview_insight,
      listingStatus: null,
    };
  });
}

/**
 * Attach the for-sale signal to a result set.
 *
 * There is no listing feed, so this is what puts a price and a "for sale" badge on
 * the map. Cached statuses cover the whole set; uncached ones are checked live up to
 * an internal cap, so a result set warms the cache for the next search over the same
 * ground. Runs in the worker rather than the API handler because the live checks are
 * web search plus Bedrock and would not fit inside the API Gateway timeout.
 */
async function attachListingStatus(results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;

  try {
    const statuses = await getListingStatusesForParcels(
      results.map((r) => ({
        parcelNumber: r.parcel.parcelNumber,
        address: r.parcel.address,
      }))
    );

    let forSaleCount = 0;

    const withStatus = results.map((r) => {
      const status = r.parcel.parcelNumber ? statuses.get(r.parcel.parcelNumber) : undefined;
      if (!status) return r;
      if (status.forSale) forSaleCount++;

      return {
        ...r,
        listingStatus: {
          forSale: status.forSale,
          confidence: status.confidence,
          price: status.price,
          listingUrl: status.listingUrl,
          source: status.source,
        },
      };
    });

    metrics.addMetric('SearchListingStatusResolved', MetricUnit.Count, statuses.size);
    metrics.addMetric('SearchResultsForSale', MetricUnit.Count, forSaleCount);

    // Parcels that are actually for sale lead, without dropping the rest: a buyer
    // researching a specific area still wants the parcels that are not listed.
    return [
      ...withStatus.filter((r) => r.listingStatus?.forSale),
      ...withStatus.filter((r) => !r.listingStatus?.forSale),
    ];
  } catch (err) {
    // A search with no for-sale badges is worth more than a failed search.
    logger.warn('Listing status enrichment failed, returning results unenriched', {
      error: err instanceof Error ? err.message : String(err),
    });
    metrics.addMetric('SearchListingStatusFailed', MetricUnit.Count, 1);
    return results;
  }
}

async function processSearchJob(messageBody: string): Promise<void> {
  const message = JSON.parse(messageBody) as SearchJobMessage;
  const { searchId, userId, criteria } = message;

  logger.info('Processing search job', { searchId, userId, state: criteria.state, county: criteria.county });

  // STATUS is a DynamoDB reserved word — must use ExpressionAttributeNames
  await docClient.send(
    new UpdateCommand({
      TableName: SEARCHES_TABLE,
      Key: { searchId },
      UpdateExpression: 'SET #st = :status',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: { ':status': 'processing' },
    })
  );

  const start = Date.now();
  const results = await attachListingStatus(await executeSearch(criteria));
  const durationMs = Date.now() - start;

  await docClient.send(
    new UpdateCommand({
      TableName: SEARCHES_TABLE,
      Key: { searchId },
      UpdateExpression:
        'SET #st = :status, resultCount = :resultCount, completedAt = :completedAt, results = :results',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':status': 'completed',
        ':resultCount': results.length,
        ':completedAt': new Date().toISOString(),
        ':results': results.slice(0, 100),
      },
    })
  );

  metrics.addMetric('SearchWorkerSucceeded', MetricUnit.Count, 1);
  metrics.addMetric('SearchLatency', MetricUnit.Milliseconds, durationMs);
  metrics.addMetric('SearchResultCount', MetricUnit.Count, results.length);

  logger.info('Search job completed', { searchId, resultCount: results.length, durationMs });
}

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  logger.addContext(context);

  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      await processSearchJob(record.body);
    } catch (err) {
      logger.error('Failed to process search job — will retry via SQS', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      metrics.addMetric('SearchWorkerFailed', MetricUnit.Count, 1);
      // Return the messageId so SQS retries this record rather than the entire batch
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  metrics.publishStoredMetrics();
  return { batchItemFailures };
}
