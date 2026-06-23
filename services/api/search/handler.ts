import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { success, badRequest, notFound, serverError } from '../shared/response';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import { getUserIdFromEvent } from '../shared/auth';
import type { SearchCriteria, SearchJob } from '@landfinder/shared';
import { v4 as uuidv4 } from 'uuid';

const dynamoClient = tracer.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const sqsClient = tracer.captureAWSv3Client(new SQSClient({}));

const SEARCHES_TABLE = process.env.SEARCHES_TABLE;
if (!SEARCHES_TABLE) throw new Error('SEARCHES_TABLE environment variable not set');

const SEARCH_QUEUE_URL = process.env.SEARCH_QUEUE_URL;
if (!SEARCH_QUEUE_URL) throw new Error('SEARCH_QUEUE_URL environment variable not set');

async function submitSearch(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const userId = getUserIdFromEvent(event);
  if (!userId) {
    return badRequest('User ID not found in token');
  }

  if (!event.body) {
    return badRequest('Request body is required');
  }

  let criteria: SearchCriteria;
  try {
    criteria = JSON.parse(event.body) as SearchCriteria;
  } catch {
    return badRequest('Invalid JSON in request body');
  }

  if (!criteria.state) {
    return badRequest('State is required');
  }

  const searchId = uuidv4();
  const now = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  await docClient.send(
    new PutCommand({
      TableName: SEARCHES_TABLE,
      Item: {
        searchId,
        userId,
        criteria,
        status: 'pending',
        resultCount: null,
        createdAt: now,
        completedAt: null,
        ttl,
      },
    })
  );

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: SEARCH_QUEUE_URL,
      MessageBody: JSON.stringify({ searchId, userId, criteria, createdAt: now }),
      // MessageGroupId not needed for standard queue; for FIFO would use userId to serialize per-user
    })
  );

  metrics.addMetric('SearchSubmitted', MetricUnit.Count, 1);
  logger.info('Search job queued', { searchId, userId, state: criteria.state, county: criteria.county });

  const searchJob: SearchJob = {
    id: searchId,
    criteria,
    status: 'pending',
    resultCount: null,
    createdAt: now,
    completedAt: null,
  };

  return success(searchJob);
}

async function getSearchStatus(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return badRequest('Job ID is required');
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: SEARCHES_TABLE,
      Key: { searchId: jobId },
    })
  );

  if (!result.Item) {
    return notFound('Search job not found');
  }

  const searchJob: SearchJob = {
    id: result.Item.searchId,
    criteria: result.Item.criteria,
    status: result.Item.status,
    resultCount: result.Item.resultCount ?? null,
    createdAt: result.Item.createdAt,
    completedAt: result.Item.completedAt ?? null,
  };

  return success(searchJob);
}

async function getSearchResults(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return badRequest('Job ID is required');
  }

  const page = parseInt(event.queryStringParameters?.page || '1', 10);
  const pageSize = Math.min(
    parseInt(event.queryStringParameters?.pageSize || '20', 10),
    100
  );

  const result = await docClient.send(
    new GetCommand({
      TableName: SEARCHES_TABLE,
      Key: { searchId: jobId },
    })
  );

  if (!result.Item) {
    return notFound('Search job not found');
  }

  if (result.Item.status !== 'completed') {
    return success({ items: [], totalCount: 0, page, pageSize, hasMore: false });
  }

  const allResults: unknown[] = result.Item.results || [];
  const totalCount = allResults.length;
  const startIndex = (page - 1) * pageSize;
  const items = allResults.slice(startIndex, startIndex + pageSize);

  return success({
    items,
    totalCount,
    page,
    pageSize,
    hasMore: startIndex + pageSize < totalCount,
  });
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.addContext(context);

  try {
    const { httpMethod, resource, path } = event;

    if (httpMethod === 'POST' && resource === '/search') {
      return await submitSearch(event);
    }

    if (httpMethod === 'GET' && resource === '/search/{jobId}') {
      return await getSearchStatus(event);
    }

    if (httpMethod === 'GET' && path.endsWith('/results')) {
      return await getSearchResults(event);
    }

    return badRequest('Invalid endpoint');
  } catch (err) {
    logger.error('Unhandled search handler error', {
      error: err instanceof Error ? err.message : String(err),
    });
    return serverError('An error occurred processing the search');
  } finally {
    metrics.publishStoredMetrics();
  }
}
