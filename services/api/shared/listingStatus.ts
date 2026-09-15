import { queryOne, execute } from './db';
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
