import type { SQSEvent, SQSBatchResponse, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { SearchCriteria, SearchResult } from '@lastbestland/shared';
import { env } from '../shared/env';
import { query } from '../shared/db';
import { getListingStatusesForParcels } from '../shared/listingStatus';
import { toParcel, type ParcelRow } from '../shared/parcels';
import { buildSearchQuery } from './query';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { tracer } from '../shared/tracer';
import type { SearchJobMessage } from './types';

const docClient = DynamoDBDocumentClient.from(tracer.captureAWSv3Client(new DynamoDBClient({})));

interface SearchRow extends ParcelRow {
  has_water_rights: boolean;
  preview_insight: string | null;
}

async function executeSearch(criteria: SearchCriteria): Promise<SearchResult[]> {
  const { sql, params } = buildSearchQuery(criteria);
  const rows = await query<SearchRow>(sql, params);
  return rows.map((row) => ({
    parcel: toParcel(row),
    hasWaterRights: row.has_water_rights,
    previewInsight: row.preview_insight,
    listingStatus: null,
  }));
}

/**
 * Attaches the for-sale check to each result. Runs here rather than in the API
 * handler because the live checks would not fit inside the API Gateway
 * timeout. Parcels that are for sale sort first without dropping the rest.
 */
async function attachListingStatus(results: SearchResult[]): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  try {
    const statuses = await getListingStatusesForParcels(
      results.map((result) => ({ parcelNumber: result.parcel.parcelNumber, address: result.parcel.address }))
    );
    const withStatus = results.map((result) => {
      const status = result.parcel.parcelNumber ? statuses.get(result.parcel.parcelNumber) : undefined;
      if (!status) return result;
      const { forSale, confidence, price, listingUrl, source } = status;
      return { ...result, listingStatus: { forSale, confidence, price, listingUrl, source } };
    });
    metrics.addMetric('SearchListingStatusResolved', MetricUnit.Count, statuses.size);
    metrics.addMetric('SearchResultsForSale', MetricUnit.Count, withStatus.filter((r) => r.listingStatus?.forSale).length);
    return [
      ...withStatus.filter((r) => r.listingStatus?.forSale),
      ...withStatus.filter((r) => !r.listingStatus?.forSale),
    ];
  } catch (err) {
    logger.warn('Listing status enrichment failed, returning results unenriched', { error: String(err) });
    metrics.addMetric('SearchListingStatusFailed', MetricUnit.Count, 1);
    return results;
  }
}

async function updateJobStatus(searchId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const names: Record<string, string> = { '#st': 'status' };
  const values: Record<string, unknown> = { ':status': status };
  const sets = ['#st = :status'];
  for (const [key, value] of Object.entries(extra)) {
    sets.push(`${key} = :${key}`);
    values[`:${key}`] = value;
  }
  await docClient.send(
    new UpdateCommand({
      TableName: env.searchesTable,
      Key: { searchId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  );
}

async function processSearchJob(messageBody: string): Promise<void> {
  const { searchId, criteria } = JSON.parse(messageBody) as SearchJobMessage;
  logger.info('Processing search job', { searchId, state: criteria.state, county: criteria.county });

  await updateJobStatus(searchId, 'processing');
  const start = Date.now();
  const results = await attachListingStatus(await executeSearch(criteria));
  const durationMs = Date.now() - start;

  await updateJobStatus(searchId, 'completed', {
    resultCount: results.length,
    completedAt: new Date().toISOString(),
    results,
  });

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
      logger.error('Search job failed, SQS will retry', { messageId: record.messageId, error: String(err) });
      metrics.addMetric('SearchWorkerFailed', MetricUnit.Count, 1);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  metrics.publishStoredMetrics();
  return { batchItemFailures };
}
