import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { upsertParcel, closePool } from '../shared/db';
import { MONTANA_COUNTIES } from '@landfinder/shared';

const CADASTRAL_BASE_URL = 'https://gis.dnrc.mt.gov/arcgis/rest/services';
const PARCEL_SERVICE = '/Cadastral/Cadastral_Parcels/MapServer/0';
const REQUEST_TIMEOUT_MS = 60_000;

interface ParcelFeature {
  attributes: {
    OBJECTID: number;
    PARCELID: string;
    GEOCODE: string;
    COUNTYNAME: string;
    OWNERNAME: string;
    OWNERADDRESS: string;
    OWNERCITY: string;
    OWNERSTATE: string;
    OWNERZIP: string;
    PROPERTYADDRESS: string;
    ACRES: number;
    LEGAL: string;
    TOWNSHIP: string;
    RANGE: string;
    SECTION: string;
    MARKETVALUE: number;
    TAXABLEVALUE: number;
  };
  geometry?: {
    rings: number[][][];
  };
}

interface ArcGISResponse {
  features: ParcelFeature[];
  exceededTransferLimit?: boolean;
  error?: { message: string };
}

const s3Client = new S3Client({});

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LandFinder/1.0 (Property Research Tool)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function queryParcels(
  county: string,
  offset = 0,
  limit = 1000
): Promise<ArcGISResponse> {
  const params = new URLSearchParams({
    where: `COUNTYNAME = '${county.toUpperCase().replace(/'/g, "''")}'`,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    resultOffset: String(offset),
    resultRecordCount: String(limit),
  });

  const res = await fetchWithTimeout(
    `${CADASTRAL_BASE_URL}${PARCEL_SERVICE}/query?${params}`
  );
  if (!res.ok) throw new Error(`Cadastral API HTTP ${res.status}`);
  return await res.json() as ArcGISResponse;
}

async function queryParcelsByAcreage(
  county: string,
  minAcres: number,
  maxAcres?: number,
  offset = 0,
  limit = 1000
): Promise<ArcGISResponse> {
  let where = `COUNTYNAME = '${county.toUpperCase().replace(/'/g, "''")}' AND ACRES >= ${minAcres}`;
  if (maxAcres !== undefined) {
    where += ` AND ACRES <= ${maxAcres}`;
  }

  const params = new URLSearchParams({
    where,
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
    resultOffset: String(offset),
    resultRecordCount: String(limit),
  });

  const res = await fetchWithTimeout(
    `${CADASTRAL_BASE_URL}${PARCEL_SERVICE}/query?${params}`
  );
  if (!res.ok) throw new Error(`Cadastral API HTTP ${res.status}`);
  return await res.json() as ArcGISResponse;
}

function calculateCentroid(rings: number[][][]): { lat: number; lng: number } | null {
  const outerRing = rings[0];
  if (!outerRing || outerRing.length === 0) return null;

  let sumLat = 0;
  let sumLng = 0;
  for (const point of outerRing) {
    sumLng += point[0] ?? 0;
    sumLat += point[1] ?? 0;
  }
  return { lat: sumLat / outerRing.length, lng: sumLng / outerRing.length };
}

async function processFeature(feature: ParcelFeature): Promise<string | null> {
  const { attributes, geometry } = feature;

  if (!attributes.PARCELID) {
    console.warn('Skipping feature without PARCELID');
    return null;
  }

  let latitude: number | null = null;
  let longitude: number | null = null;
  let boundaryGeoJson: string | null = null;

  if (geometry?.rings) {
    boundaryGeoJson = JSON.stringify({ type: 'Polygon', coordinates: geometry.rings });
    const centroid = calculateCentroid(geometry.rings);
    if (centroid) {
      latitude = centroid.lat;
      longitude = centroid.lng;
    }
  }

  return upsertParcel({
    state: 'MT',
    county: attributes.COUNTYNAME,
    parcelNumber: attributes.PARCELID,
    geoId: attributes.GEOCODE,
    address: attributes.PROPERTYADDRESS || null,
    acreage: attributes.ACRES || null,
    latitude,
    longitude,
    boundaryGeoJson,
  });
}

async function scrapeCounty(county: string): Promise<{ processed: number; errors: number }> {
  console.log(`Starting scrape for ${county} County, MT`);

  let offset = 0;
  const limit = 1000;
  let processed = 0;
  let errors = 0;
  let hasMore = true;

  while (hasMore) {
    try {
      console.log(`Fetching parcels ${offset} to ${offset + limit}...`);
      const response = await queryParcels(county, offset, limit);

      if (!response.features || response.features.length === 0) {
        hasMore = false;
        break;
      }

      for (const feature of response.features) {
        try {
          const parcelId = await processFeature(feature);
          if (parcelId) processed++;
        } catch (err) {
          console.error(`Error processing parcel ${feature.attributes?.PARCELID}:`, err);
          errors++;
        }
      }

      hasMore = response.exceededTransferLimit === true;
      offset += limit;

      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`Error fetching parcels at offset ${offset}:`, err);
      errors++;
      hasMore = false;
    }
  }

  console.log(`Completed ${county} County: ${processed} processed, ${errors} errors`);
  return { processed, errors };
}

async function scrapeAllCounties(): Promise<void> {
  const results: Record<string, { processed: number; errors: number }> = {};

  for (const county of MONTANA_COUNTIES) {
    try {
      results[county] = await scrapeCounty(county);
    } catch (err) {
      console.error(`Failed to scrape ${county} County:`, err);
      results[county] = { processed: 0, errors: 1 };
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    counties: results,
    totals: {
      processed: Object.values(results).reduce((sum, r) => sum + r.processed, 0),
      errors: Object.values(results).reduce((sum, r) => sum + r.errors, 0),
    },
  };

  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET || 'landfinder-scraping',
      Key: `cadastral/runs/${new Date().toISOString().split('T')[0]}.json`,
      Body: JSON.stringify(summary, null, 2),
      ContentType: 'application/json',
    })
  );

  console.log('Scrape complete:', summary.totals);
}

async function scrapeLargeParcels(minAcres = 2): Promise<void> {
  console.log(`Scraping parcels >= ${minAcres} acres across all counties`);

  let totalProcessed = 0;
  let totalErrors = 0;

  for (const county of MONTANA_COUNTIES) {
    console.log(`Processing ${county} County...`);

    let offset = 0;
    const limit = 1000;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await queryParcelsByAcreage(county, minAcres, undefined, offset, limit);

        if (!response.features || response.features.length === 0) {
          hasMore = false;
          break;
        }

        for (const feature of response.features) {
          try {
            const parcelId = await processFeature(feature);
            if (parcelId) totalProcessed++;
          } catch (err) {
            console.error(`Error processing parcel ${feature.attributes?.PARCELID}:`, err);
            totalErrors++;
          }
        }

        hasMore = response.exceededTransferLimit === true;
        offset += limit;

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`Error fetching parcels for ${county}:`, err);
        totalErrors++;
        hasMore = false;
      }
    }
  }

  console.log(`Large parcels scrape complete: ${totalProcessed} processed, ${totalErrors} errors`);
}

async function main() {
  const mode = process.env.SCRAPE_MODE || 'large';

  try {
    if (mode === 'all') {
      await scrapeAllCounties();
    } else if (mode === 'large') {
      const minAcres = parseInt(process.env.MIN_ACRES || '2', 10);
      await scrapeLargeParcels(minAcres);
    } else if (mode === 'county') {
      const county = process.env.COUNTY;
      if (!county) throw new Error('COUNTY environment variable required for county mode');
      await scrapeCounty(county);
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
