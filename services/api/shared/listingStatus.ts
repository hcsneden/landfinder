import { query, queryOne, execute } from './db';
import { searchWeb } from './webSearch';
import { checkListingStatusFromSearchResults } from './bedrock';
import { logger } from './logger';

const LISTING_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ListingStatusResult {
  forSale: boolean;
  confidence: 'high' | 'medium' | 'low';
  price: number | null;
  listingUrl: string | null;
  source: string | null;
  summary: string;
  fetchedAt: string;
}

interface CacheRow {
  for_sale: boolean;
  confidence: string;
  price: number | null;
  listing_url: string | null;
  source: string | null;
  summary: string;
  fetched_at: string;
}

// Keyed by the cadastral PARCELID rather than the internal parcels.id UUID, since
// candidate parcels from an ambiguous search aren't upserted into `parcels` until
// the user picks one — this lets us cache/check them before that happens.
export async function getOrCheckListingStatus(
  parcelNumber: string,
  address: string | null,
  opts: { forceRefresh?: boolean } = {}
): Promise<ListingStatusResult | null> {
  if (!address) return null;

  const cached = await queryOne<CacheRow>(
    `SELECT for_sale, confidence, price, listing_url, source, summary, fetched_at::text
     FROM listing_status_cache WHERE parcel_number = $1`,
    [parcelNumber]
  );
  const cacheAge = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;

  if (!opts.forceRefresh && cached && cacheAge <= LISTING_STATUS_TTL_MS) {
    return {
      forSale: cached.for_sale,
      confidence: cached.confidence as ListingStatusResult['confidence'],
      price: cached.price,
      listingUrl: cached.listing_url,
      source: cached.source,
      summary: cached.summary,
      fetchedAt: cached.fetched_at,
    };
  }

  try {
    const searchResults = await searchWeb(`"${address}" for sale`);
    const result = await checkListingStatusFromSearchResults(address, searchResults);
    const fetchedAt = new Date().toISOString();
    await execute(
      `INSERT INTO listing_status_cache (parcel_number, for_sale, confidence, price, listing_url, source, summary, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (parcel_number) DO UPDATE SET
         for_sale = EXCLUDED.for_sale,
         confidence = EXCLUDED.confidence,
         price = EXCLUDED.price,
         listing_url = EXCLUDED.listing_url,
         source = EXCLUDED.source,
         summary = EXCLUDED.summary,
         fetched_at = NOW()`,
      [parcelNumber, result.forSale, result.confidence, result.price, result.listingUrl, result.source, result.summary]
    );
    return { ...result, fetchedAt };
  } catch (err) {
    logger.warn('Listing status check failed', {
      parcelNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Each fresh check is a web search plus a Bedrock call, so a result set is served
// from cache first and only a bounded number of misses are checked live. The rest
// come back null and get filled on a later search that hits the same parcels.
const BATCH_LIVE_CHECK_CAP = 15;
const BATCH_CONCURRENCY = 5;

function rowToResult(row: CacheRow): ListingStatusResult {
  return {
    forSale: row.for_sale,
    confidence: row.confidence as ListingStatusResult['confidence'],
    price: row.price,
    listingUrl: row.listing_url,
    source: row.source,
    summary: row.summary,
    fetchedAt: row.fetched_at,
  };
}

// One query for the whole result set rather than a round trip per parcel.
async function getCachedListingStatuses(
  parcelNumbers: string[]
): Promise<Map<string, ListingStatusResult>> {
  if (parcelNumbers.length === 0) return new Map();

  const rows = await query<CacheRow & { parcel_number: string }>(
    `SELECT parcel_number, for_sale, confidence, price, listing_url, source, summary, fetched_at::text
     FROM listing_status_cache
     WHERE parcel_number = ANY($1::text[])
       AND fetched_at > NOW() - INTERVAL '7 days'`,
    [parcelNumbers]
  );

  return new Map(rows.map((r) => [r.parcel_number, rowToResult(r)]));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * For-sale status for a set of parcels, keyed by cadastral parcel number.
 *
 * Cache hits are free. Misses are checked live up to BATCH_LIVE_CHECK_CAP, in the
 * order given, so callers should pass the parcels a user is most likely to look at
 * first. A parcel with no address cannot be checked and is omitted.
 */
export async function getListingStatusesForParcels(
  parcels: Array<{ parcelNumber: string | null; address: string | null }>
): Promise<Map<string, ListingStatusResult>> {
  const addressable = parcels.filter(
    (p): p is { parcelNumber: string; address: string } => !!p.parcelNumber && !!p.address
  );
  if (addressable.length === 0) return new Map();

  const statuses = await getCachedListingStatuses(addressable.map((p) => p.parcelNumber));

  const misses = addressable
    .filter((p) => !statuses.has(p.parcelNumber))
    .slice(0, BATCH_LIVE_CHECK_CAP);

  if (misses.length > 0) {
    const checked = await mapWithConcurrency(misses, BATCH_CONCURRENCY, (p) =>
      getOrCheckListingStatus(p.parcelNumber, p.address)
    );

    checked.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value) {
        statuses.set(misses[i]!.parcelNumber, r.value);
      }
    });
  }

  logger.info('Batch listing status resolved', {
    requested: addressable.length,
    resolved: statuses.size,
    liveChecks: misses.length,
  });

  return statuses;
}
