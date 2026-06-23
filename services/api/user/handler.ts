import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { query, execute } from '../shared/db';
import { success, created, badRequest, notFound, serverError } from '../shared/response';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import { getUserIdFromEvent } from '../shared/auth';
import type { SavedParcel, SearchJob } from '@landfinder/shared';

const SEARCHES_TABLE = process.env.SEARCHES_TABLE;
if (!SEARCHES_TABLE) throw new Error('SEARCHES_TABLE environment variable not set');

const dynamoClient = tracer.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(dynamoClient);

async function getSavedParcels(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = getUserIdFromEvent(event);
  if (!userId) {
    return badRequest('User ID not found in token');
  }

  const sql = `
    SELECT user_id, parcel_id, notes, saved_at
    FROM user_saved_parcels
    WHERE user_id = $1
    ORDER BY saved_at DESC
  `;

  interface SavedRow {
    user_id: string;
    parcel_id: string;
    notes: string | null;
    saved_at: string;
  }

  const rows = await query<SavedRow>(sql, [userId]);

  const savedParcels: SavedParcel[] = rows.map((row) => ({
    userId: row.user_id,
    parcelId: row.parcel_id,
    notes: row.notes,
    savedAt: row.saved_at,
  }));

  return success(savedParcels);
}

async function saveParcel(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = getUserIdFromEvent(event);
  if (!userId) {
    return badRequest('User ID not found in token');
  }

  const parcelId = event.pathParameters?.parcelId;
  if (!parcelId) {
    return badRequest('Parcel ID is required');
  }

  let notes: string | null = null;
  if (event.body) {
    let parsed: { notes?: unknown };
    try {
      parsed = JSON.parse(event.body) as { notes?: unknown };
    } catch {
      return badRequest('Invalid JSON in request body');
    }
    notes = typeof parsed.notes === 'string' ? parsed.notes : null;
  }

  const now = new Date().toISOString();

  const sql = `
    INSERT INTO user_saved_parcels (user_id, parcel_id, notes, saved_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, parcel_id)
    DO UPDATE SET notes = $3, saved_at = $4
    RETURNING user_id, parcel_id, notes, saved_at
  `;

  interface SavedRow {
    user_id: string;
    parcel_id: string;
    notes: string | null;
    saved_at: string;
  }

  const rows = await query<SavedRow>(sql, [userId, parcelId, notes, now]);

  if (rows.length === 0) {
    return serverError('Failed to save parcel');
  }

  const row = rows[0];
  const savedParcel: SavedParcel = {
    userId: row.user_id,
    parcelId: row.parcel_id,
    notes: row.notes,
    savedAt: row.saved_at,
  };

  metrics.addMetric('ParcelSaved', MetricUnit.Count, 1);
  return created(savedParcel);
}

async function removeSavedParcel(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = getUserIdFromEvent(event);
  if (!userId) {
    return badRequest('User ID not found in token');
  }

  const parcelId = event.pathParameters?.parcelId;
  if (!parcelId) {
    return badRequest('Parcel ID is required');
  }

  const sql = `
    DELETE FROM user_saved_parcels
    WHERE user_id = $1 AND parcel_id = $2
  `;

  const rowCount = await execute(sql, [userId, parcelId]);

  if (rowCount === 0) {
    return notFound('Saved parcel not found');
  }

  metrics.addMetric('ParcelUnsaved', MetricUnit.Count, 1);
  return success({ message: 'Parcel removed from saved list' });
}

async function getSearchHistory(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = getUserIdFromEvent(event);
  if (!userId) {
    return badRequest('User ID not found in token');
  }

  const result = await docClient.send(
    new QueryCommand({
      TableName: SEARCHES_TABLE,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      ScanIndexForward: false,
      Limit: 50,
    })
  );

  const searches: SearchJob[] = (result.Items ?? []).map((item) => ({
    id: item.searchId,
    criteria: item.criteria,
    status: item.status,
    resultCount: item.resultCount ?? null,
    createdAt: item.createdAt,
    completedAt: item.completedAt ?? null,
  }));

  return success(searches);
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    const { httpMethod, resource, path } = event;

    if (httpMethod === 'GET' && resource === '/user/saved') {
      return await getSavedParcels(event);
    }

    if (httpMethod === 'POST' && resource === '/user/saved/{parcelId}') {
      return await saveParcel(event);
    }

    if (httpMethod === 'DELETE' && resource === '/user/saved/{parcelId}') {
      return await removeSavedParcel(event);
    }

    if (httpMethod === 'GET' && path.endsWith('/searches')) {
      return await getSearchHistory(event);
    }

    return badRequest('Invalid endpoint');
  } catch (err) {
    logger.error('User handler error', { error: err instanceof Error ? err.message : String(err) });
    return serverError('An error occurred processing the request');
  } finally {
    metrics.publishStoredMetrics();
  }
}
