import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { PaginatedResponse, SearchCriteria, SearchJob, SearchResult } from '@lastbestland/shared';
import { env } from '../shared/env';
import { success, badRequest, notFound, serverError } from '../shared/response';
import { getUserId, getPathParameter, getPositiveIntParameter, parseJsonBody } from '../shared/request';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import type { SearchJobMessage, SearchJobItem } from './types';

const docClient = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})));
const sqsClient = tracer.captureAWSv3Client(new SQSClient({}));

const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_PAGE_SIZE = 100;

function toSearchJob(item: SearchJobItem): SearchJob {
  return {
    id: item.searchId,
    criteria: item.criteria,
    status: item.status,
    resultCount: item.resultCount ?? null,
    createdAt: item.createdAt,
    completedAt: item.completedAt ?? null,
  };
}

/**
 * Loads a search job the caller is allowed to read: an anonymous job, which the
 * unguessable id alone authorizes, or one owned by the calling user. Returns null
 * when the job is missing or owned by someone else.
 */
async function loadReadableJob(event: APIGatewayProxyEvent): Promise<SearchJobItem | null> {
  const searchId = getPathParameter(event, 'jobId');
  if (!searchId) return null;
  const result = await docClient.send(new GetCommand({ TableName: env.searchesTable, Key: { searchId } }));
  const item = result.Item as SearchJobItem | undefined;
  if (!item) return null;
  if (!item.userId) return item;
  return item.userId === getUserId(event) ? item : null;
}

async function submitSearch(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Anonymous searches are allowed. A signed-in caller gets the job attributed so
  // it shows up in their history; everyone else gets an unowned job.
  const userId = getUserId(event);
  const criteria = parseJsonBody<SearchCriteria>(event);
  if (!criteria?.state) return badRequest('State is required');

  const searchId = randomUUID();
  const createdAt = new Date().toISOString();
  const item: SearchJobItem = {
    searchId,
    ...(userId ? { userId } : {}),
    criteria,
    status: 'pending',
    createdAt,
    ttl: Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS,
  };
  await docClient.send(new PutCommand({ TableName: env.searchesTable, Item: item }));

  const message: SearchJobMessage = { searchId, criteria };
  await sqsClient.send(new SendMessageCommand({ QueueUrl: env.searchQueueUrl, MessageBody: JSON.stringify(message) }));

  metrics.addMetric('SearchSubmitted', MetricUnit.Count, 1);
  logger.info('Search job queued', { searchId, userId, state: criteria.state, county: criteria.county });
  return success(toSearchJob(item));
}

async function getSearchStatus(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const job = await loadReadableJob(event);
  return job ? success(toSearchJob(job)) : notFound('Search job not found');
}

async function getSearchResults(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const job = await loadReadableJob(event);
  if (!job) return notFound('Search job not found');

  const page = getPositiveIntParameter(event, 'page', 1);
  const pageSize = Math.min(getPositiveIntParameter(event, 'pageSize', 20), MAX_PAGE_SIZE);
  const allResults = job.status === 'completed' ? job.results ?? [] : [];
  const start = (page - 1) * pageSize;
  const response: PaginatedResponse<SearchResult> = {
    items: allResults.slice(start, start + pageSize),
    totalCount: allResults.length,
    page,
    pageSize,
    hasMore: start + pageSize < allResults.length,
  };
  return success(response);
}

const routes: Record<string, (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>> = {
  'POST /search': submitSearch,
  'GET /search/{jobId}': getSearchStatus,
  'GET /search/{jobId}/results': getSearchResults,
};

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    const route = routes[`${event.httpMethod} ${event.resource}`];
    return route ? await route(event) : notFound('Unknown endpoint');
  } catch (err) {
    logger.error('Unhandled search handler error', { error: String(err) });
    return serverError('An error occurred processing the search');
  } finally {
    metrics.publishStoredMetrics();
  }
}
