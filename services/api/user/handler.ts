import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SavedParcel, SearchJob } from '@lastbestland/shared';
import { env } from '../shared/env';
import { query, execute } from '../shared/db';
import { success, created, badRequest, notFound, serverError } from '../shared/response';
import { getUserId, getPathParameter, parseJsonBody } from '../shared/request';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import type { SearchJobItem } from '../search/types';

const docClient = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})));

const SEARCH_HISTORY_LIMIT = 50;

interface SavedRow {
  user_id: string;
  parcel_id: string;
  notes: string | null;
  saved_at: string;
}

const toSavedParcel = (row: SavedRow): SavedParcel => ({
  userId: row.user_id,
  parcelId: row.parcel_id,
  notes: row.notes,
  savedAt: row.saved_at,
});

async function getSavedParcels(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const rows = await query<SavedRow>(
    'SELECT user_id, parcel_id, notes, saved_at FROM user_saved_parcels WHERE user_id = $1 ORDER BY saved_at DESC',
    [userId]
  );
  return success(rows.map(toSavedParcel));
}

async function saveParcel(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const parcelId = getPathParameter(event, 'parcelId');
  if (!parcelId) return badRequest('Parcel ID is required');
  const body = parseJsonBody<{ notes?: unknown }>(event);
  const notes = typeof body?.notes === 'string' ? body.notes : null;

  const rows = await query<SavedRow>(
    `INSERT INTO user_saved_parcels (user_id, parcel_id, notes)
     VALUES ($1, $2::uuid, $3)
     ON CONFLICT (user_id, parcel_id) DO UPDATE SET notes = EXCLUDED.notes, saved_at = NOW()
     RETURNING user_id, parcel_id, notes, saved_at`,
    [userId, parcelId, notes]
  );
  if (!rows[0]) return serverError('Failed to save parcel');
  metrics.addMetric('ParcelSaved', MetricUnit.Count, 1);
  return created(toSavedParcel(rows[0]));
}

async function removeSavedParcel(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const parcelId = getPathParameter(event, 'parcelId');
  if (!parcelId) return badRequest('Parcel ID is required');
  const deleted = await execute('DELETE FROM user_saved_parcels WHERE user_id = $1 AND parcel_id = $2::uuid', [userId, parcelId]);
  if (deleted === 0) return notFound('Saved parcel not found');
  metrics.addMetric('ParcelUnsaved', MetricUnit.Count, 1);
  return success({ message: 'Parcel removed from saved list' });
}

async function getSearchHistory(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: env.searchesTable,
      IndexName: 'userId-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      ScanIndexForward: false,
      Limit: SEARCH_HISTORY_LIMIT,
    })
  );
  const searches: SearchJob[] = ((result.Items ?? []) as SearchJobItem[]).map((item) => ({
    id: item.searchId,
    criteria: item.criteria,
    status: item.status,
    resultCount: item.resultCount ?? null,
    createdAt: item.createdAt,
    completedAt: item.completedAt ?? null,
  }));
  return success(searches);
}

type Route = (event: APIGatewayProxyEvent, userId: string) => Promise<APIGatewayProxyResult>;

const routes: Record<string, Route> = {
  'GET /user/saved': getSavedParcels,
  'POST /user/saved/{parcelId}': saveParcel,
  'DELETE /user/saved/{parcelId}': removeSavedParcel,
  'GET /user/searches': getSearchHistory,
};

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const userId = getUserId(event);
    if (!userId) return badRequest('User ID not found in token');
    const route = routes[`${event.httpMethod} ${event.resource}`];
    return route ? await route(event, userId) : notFound('Unknown endpoint');
  } catch (err) {
    logger.error('User handler error', { error: String(err) });
    return serverError('An error occurred processing the request');
  } finally {
    metrics.publishStoredMetrics();
  }
}
