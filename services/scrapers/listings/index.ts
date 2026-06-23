/**
 * Land Listings Scraper
 *
 * Aggregates land listings from multiple sources:
 * - LandWatch
 * - Land.com
 * - Montana Land Source (future)
 *
 * Uses Playwright for dynamic content and AI for data extraction
 */

import { chromium, Browser, Page } from 'playwright';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { query, closePool } from '../shared/db';
import type { ListingSource } from '@landfinder/shared';

interface ListingData {
  source: ListingSource;
  sourceId: string;
  price: number | null;
  listingUrl: string;
  description: string | null;
  images: string[];
  acreage: number | null;
  county: string | null;
  address: string | null;
  listedAt: string | null;
  rawData: Record<string, unknown>;
}

const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({});

class ListingsScraper {
  private browser: Browser | null = null;
  private bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET || 'landfinder-scraping';
  }

  async init(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    await closePool();
  }

  async scrapeLandWatch(county?: string): Promise<ListingData[]> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const listings: ListingData[] = [];
    const page = await this.browser.newPage();

    try {
      // Build URL
      let url = 'https://www.landwatch.com/montana-land-for-sale';
      if (county) {
        url = `https://www.landwatch.com/${county.toLowerCase()}-county-montana-land-for-sale`;
      }

      console.log(`Scraping LandWatch: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      // Wait for listings to load
      await page.waitForSelector('.property-card, .listing-card', {
        timeout: 30000,
      });

      // Get all listing cards
      const cards = await page.$$('.property-card, .listing-card');

      for (const card of cards) {
        try {
          // Extract listing URL
          const linkElement = await card.$('a[href*="/land/"]');
          const href = await linkElement?.getAttribute('href');
          if (!href) continue;

          const listingUrl = href.startsWith('http')
            ? href
            : `https://www.landwatch.com${href}`;

          // Extract price
          const priceElement = await card.$('.price, .listing-price');
          const priceText = await priceElement?.textContent();
          const price = this.parsePrice(priceText || '');

          // Extract acreage
          const acreageElement = await card.$('.acres, .acreage');
          const acreageText = await acreageElement?.textContent();
          const acreage = this.parseAcreage(acreageText || '');

          // Extract location
          const locationElement = await card.$('.location, .address');
          const locationText = await locationElement?.textContent();

          // Extract image
          const imageElement = await card.$('img');
          const imageSrc = await imageElement?.getAttribute('src');

          // Extract ID from URL
          const sourceId = this.extractIdFromUrl(listingUrl, 'landwatch');

          listings.push({
            source: 'landwatch',
            sourceId,
            price,
            listingUrl,
            description: null, // Would need to visit detail page
            images: imageSrc ? [imageSrc] : [],
            acreage,
            county: county || this.extractCounty(locationText || ''),
            address: locationText?.trim() || null,
            listedAt: null,
            rawData: {
              scrapedAt: new Date().toISOString(),
              rawPrice: priceText,
              rawAcreage: acreageText,
              rawLocation: locationText,
            },
          });
        } catch (err) {
          console.error('Error extracting listing card:', err);
        }
      }
    } catch (err) {
      console.error('Error scraping LandWatch:', err);
    } finally {
      await page.close();
    }

    return listings;
  }

  async scrapeLandCom(county?: string): Promise<ListingData[]> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }

    const listings: ListingData[] = [];
    const page = await this.browser.newPage();

    try {
      let url = 'https://www.land.com/Montana/all-land/';
      if (county) {
        url = `https://www.land.com/Montana/${county.toLowerCase()}-county/all-land/`;
      }

      console.log(`Scraping Land.com: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

      // Wait for listings
      await page.waitForSelector('[data-testid="property-card"], .property-card', {
        timeout: 30000,
      });

      const cards = await page.$$('[data-testid="property-card"], .property-card');

      for (const card of cards) {
        try {
          const linkElement = await card.$('a');
          const href = await linkElement?.getAttribute('href');
          if (!href) continue;

          const listingUrl = href.startsWith('http')
            ? href
            : `https://www.land.com${href}`;

          const priceElement = await card.$('[data-testid="price"], .price');
          const priceText = await priceElement?.textContent();
          const price = this.parsePrice(priceText || '');

          const acreageElement = await card.$('[data-testid="acres"], .acres');
          const acreageText = await acreageElement?.textContent();
          const acreage = this.parseAcreage(acreageText || '');

          const addressElement = await card.$('[data-testid="address"], .address');
          const addressText = await addressElement?.textContent();

          const imageElement = await card.$('img');
          const imageSrc = await imageElement?.getAttribute('src');

          const sourceId = this.extractIdFromUrl(listingUrl, 'land.com');

          listings.push({
            source: 'land.com',
            sourceId,
            price,
            listingUrl,
            description: null,
            images: imageSrc ? [imageSrc] : [],
            acreage,
            county: county || this.extractCounty(addressText || ''),
            address: addressText?.trim() || null,
            listedAt: null,
            rawData: {
              scrapedAt: new Date().toISOString(),
              rawPrice: priceText,
              rawAcreage: acreageText,
              rawAddress: addressText,
            },
          });
        } catch (err) {
          console.error('Error extracting Land.com card:', err);
        }
      }
    } catch (err) {
      console.error('Error scraping Land.com:', err);
    } finally {
      await page.close();
    }

    return listings;
  }

  parsePrice(text: string): number | null {
    const cleaned = text.replace(/[^0-9.]/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? null : price;
  }

  parseAcreage(text: string): number | null {
    const match = text.match(/([\d,.]+)\s*(?:acres?|ac)/i);
    if (match) {
      const cleaned = match[1].replace(/,/g, '');
      return parseFloat(cleaned);
    }
    return null;
  }

  extractIdFromUrl(url: string, source: string): string {
    // Extract listing ID from URL
    const parts = url.split('/');
    const lastPart = parts[parts.length - 1] || parts[parts.length - 2];
    return `${source}_${lastPart.replace(/[^a-zA-Z0-9]/g, '')}`;
  }

  extractCounty(text: string): string | null {
    // Try to extract county name from location text
    const match = text.match(/(\w+)\s+County/i);
    return match ? match[1] : null;
  }

  async matchListingToParcel(listing: ListingData): Promise<string | null> {
    // Try to match listing to existing parcel based on:
    // 1. Exact acreage match within county
    // 2. Address similarity
    // 3. AI-assisted matching

    if (!listing.county || !listing.acreage) {
      return null;
    }

    // Try exact match first
    const sql = `
      SELECT id, address, acreage
      FROM parcels
      WHERE state = 'MT'
        AND county ILIKE $1
        AND acreage BETWEEN $2 * 0.95 AND $2 * 1.05
      LIMIT 10
    `;

    interface ParcelRow {
      id: string;
      address: string | null;
      acreage: number;
    }

    const candidates = await query<ParcelRow>(sql, [
      listing.county,
      listing.acreage,
    ]);

    if (candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0].id;
    }

    // Use AI to find best match if multiple candidates
    if (listing.address) {
      const prompt = `Match this land listing to the correct parcel:

Listing:
- Address: ${listing.address}
- Acreage: ${listing.acreage}
- County: ${listing.county}

Candidate Parcels:
${candidates.map((c, i) => `${i + 1}. ID: ${c.id}, Address: ${c.address || 'N/A'}, Acreage: ${c.acreage}`).join('\n')}

Return ONLY the number (1-${candidates.length}) of the best match, or 0 if no good match:`;

      try {
        const command = new InvokeModelCommand({
          modelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: 10,
            messages: [{ role: 'user', content: prompt }],
          }),
          contentType: 'application/json',
        });

        const response = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const matchIndex = parseInt(responseBody.content[0].text.trim(), 10);

        if (matchIndex > 0 && matchIndex <= candidates.length) {
          return candidates[matchIndex - 1].id;
        }
      } catch (err) {
        console.error('AI matching failed:', err);
      }
    }

    return null;
  }

  async saveListing(listing: ListingData, parcelId: string | null): Promise<void> {
    const sql = `
      INSERT INTO listings (
        parcel_id, source, source_id, price, listing_url,
        description, images, listed_at, scraped_at, raw_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
      ON CONFLICT (source, source_id)
      DO UPDATE SET
        parcel_id = COALESCE(EXCLUDED.parcel_id, listings.parcel_id),
        price = EXCLUDED.price,
        listing_url = EXCLUDED.listing_url,
        description = EXCLUDED.description,
        images = EXCLUDED.images,
        scraped_at = NOW(),
        raw_data = EXCLUDED.raw_data
    `;

    await query(sql, [
      parcelId,
      listing.source,
      listing.sourceId,
      listing.price,
      listing.listingUrl,
      listing.description,
      listing.images,
      listing.listedAt,
      JSON.stringify(listing.rawData),
    ]);
  }

  async scrapeAllSources(): Promise<void> {
    console.log('Starting listings scrape from all sources...');

    const allListings: ListingData[] = [];

    // Scrape LandWatch
    try {
      const landWatchListings = await this.scrapeLandWatch();
      allListings.push(...landWatchListings);
      console.log(`LandWatch: ${landWatchListings.length} listings found`);
    } catch (err) {
      console.error('LandWatch scrape failed:', err);
    }

    // Rate limit between sources
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Scrape Land.com
    try {
      const landComListings = await this.scrapeLandCom();
      allListings.push(...landComListings);
      console.log(`Land.com: ${landComListings.length} listings found`);
    } catch (err) {
      console.error('Land.com scrape failed:', err);
    }

    // Process and save listings
    let matched = 0;
    let unmatched = 0;

    for (const listing of allListings) {
      try {
        const parcelId = await this.matchListingToParcel(listing);
        await this.saveListing(listing, parcelId);

        if (parcelId) {
          matched++;
        } else {
          unmatched++;
        }
      } catch (err) {
        console.error(`Error saving listing ${listing.sourceId}:`, err);
      }
    }

    // Save summary
    const summary = {
      timestamp: new Date().toISOString(),
      totalListings: allListings.length,
      matchedToParcels: matched,
      unmatched,
      bySource: {
        landwatch: allListings.filter((l) => l.source === 'landwatch').length,
        'land.com': allListings.filter((l) => l.source === 'land.com').length,
      },
    };

    await s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `listings/runs/${new Date().toISOString().split('T')[0]}.json`,
        Body: JSON.stringify(summary, null, 2),
        ContentType: 'application/json',
      })
    );

    console.log('Listings scrape complete:', summary);
  }
}

// Main entry point
async function main() {
  const scraper = new ListingsScraper();

  try {
    await scraper.init();
    await scraper.scrapeAllSources();
  } finally {
    await scraper.close();
  }
}

main().catch((err) => {
  console.error('Listings scraper failed:', err);
  process.exit(1);
});

export { ListingsScraper };
