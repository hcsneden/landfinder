import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import type { ListingStatus } from '@lastbestland/shared';
import { success, badRequest, notFound, methodNotAllowed, serviceUnavailable, serverError } from '../shared/response';
import { getPathParameter } from '../shared/request';
import { parseRefreshFlag, getCachedParcel } from '../shared/parcelCache';
import { getOrCheckListingStatus } from '../shared/listingStatus';
import { logger } from '../shared/logger';
import { metrics, MetricUnit } from '../shared/metrics';
import { getWaterRights } from './sources/waterRights';
import { getInsights } from './sources/insights';
import { getHuntingDistricts } from './sources/huntingDistricts';
import { getStreamGauges } from './sources/streamGauges';
import { getRoadAccess } from './sources/roadAccess';
import { getUtilities } from './sources/utilities';
import { getEnvironmentalRisk } from './sources/environmentalRisk';
import { getConservationEasements } from './sources/conservationEasements';
import { getSoil } from './sources/soil';
import { getGroundwater, DEFAULT_RADIUS_MILES, MAX_RADIUS_MILES } from './sources/groundwater';

interface Request {
  parcelId: string;
  forceRefresh: boolean;
  query: Record<string, string | undefined>;
}

type Route = (request: Request) => Promise<APIGatewayProxyResult>;

function unavailable(what: string) {
  return serviceUnavailable(`${what} is unavailable for this parcel right now`);
}

const getParcel: Route = async ({ parcelId, forceRefresh }) => {
  const parcel = await getCachedParcel(parcelId, forceRefresh);
  if (!parcel) return notFound('Parcel not found');
  metrics.addMetric('ParcelDetailFetched', MetricUnit.Count, 1);
  return success(parcel);
};

const getListingStatus: Route = async ({ parcelId, forceRefresh }) => {
  // Cached: this is the same record /parcels/{id} just served, so the detail
  // view should not pay a second Aurora read for it.
  const parcel = await getCachedParcel(parcelId);
  if (!parcel) return notFound('Parcel not found');
  if (!parcel.parcelNumber || !parcel.address) {
    const status: ListingStatus = {
      parcelId,
      forSale: false,
      confidence: 'low',
      price: null,
      listingUrl: null,
      source: null,
      summary: 'No address on file for this parcel.',
      fetchedAt: new Date().toISOString(),
    };
    return success(status);
  }
  const checked = await getOrCheckListingStatus(parcel.parcelNumber, parcel.address, forceRefresh);
  if (!checked) return unavailable('Listing status');
  metrics.addMetric('ListingStatusChecked', MetricUnit.Count, 1);
  return success({ parcelId, ...checked });
};

const getGroundwaterRoute: Route = async ({ parcelId, forceRefresh, query }) => {
  const requested = Number(query.radius);
  const radiusMiles = Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_RADIUS_MILES)
    : DEFAULT_RADIUS_MILES;
  const result = await getGroundwater(parcelId, forceRefresh, radiusMiles);
  return result ? success(result) : unavailable('Groundwater data');
};

const cachedRoute =
  <T>(name: string, fetch: (parcelId: string, forceRefresh: boolean) => Promise<T | null>): Route =>
  async ({ parcelId, forceRefresh }) => {
    const result = await fetch(parcelId, forceRefresh);
    return result ? success(result) : unavailable(name);
  };

const routes: Record<string, Route> = {
  '/parcels/{id}': getParcel,
  '/parcels/{id}/water-rights': ({ parcelId }) => getWaterRights(parcelId).then(success),
  '/parcels/{id}/insights': ({ parcelId }) => getInsights(parcelId).then(success),
  '/parcels/{id}/hunting-districts': ({ parcelId }) => getHuntingDistricts(parcelId).then(success),
  '/parcels/{id}/stream-gauges': ({ parcelId }) => getStreamGauges(parcelId).then(success),
  '/parcels/{id}/road-access': cachedRoute('Road access data', getRoadAccess),
  '/parcels/{id}/utilities': cachedRoute('Utility data', getUtilities),
  '/parcels/{id}/environmental-risk': cachedRoute('Environmental data', getEnvironmentalRisk),
  '/parcels/{id}/conservation-easements': cachedRoute('Conservation easement data', getConservationEasements),
  '/parcels/{id}/soil': cachedRoute('Soil data', getSoil),
  '/parcels/{id}/groundwater': getGroundwaterRoute,
  '/parcels/{id}/listing-status': getListingStatus,
};

export async function handler(event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> {
  logger.addContext(context);
  try {
    if (event.httpMethod !== 'GET') return methodNotAllowed();
    const route = routes[event.resource];
    if (!route) return notFound('Unknown endpoint');
    const parcelId = getPathParameter(event, 'id');
    if (!parcelId) return badRequest('Parcel ID is required');
    return await route({
      parcelId,
      forceRefresh: parseRefreshFlag(event.queryStringParameters),
      query: event.queryStringParameters ?? {},
    });
  } catch (err) {
    logger.error('Unhandled parcel handler error', { error: String(err) });
    return serverError('An error occurred fetching parcel data');
  } finally {
    metrics.publishStoredMetrics();
  }
}
