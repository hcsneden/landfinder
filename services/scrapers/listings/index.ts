/**
 * Listings Scraper — stub
 *
 * Active MLS/listing data requires a real estate license or a paid data
 * partnership (e.g., Land.com API, Apify). Playwright scraping was removed
 * because it violates ToS for most listing sites. This stub exits cleanly
 * so the Step Functions workflow can proceed without blocking on listings.
 */

async function main() {
  console.log('Listings scraper: no active source configured — skipping.');
  console.log('To add listings, integrate a licensed data feed or approved API partner.');
}

main().catch((err) => {
  console.error('Listings scraper failed:', err);
  process.exit(1);
});
