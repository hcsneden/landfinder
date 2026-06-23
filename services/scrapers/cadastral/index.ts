/**
 * Montana Cadastral Scraper
 *
 * Fetches parcel data from the Montana Cadastral ArcGIS REST API
 * https://svc.mt.gov/msl/cadastral
 *
 * The Montana Cadastral service provides:
 * - Parcel boundaries
 * - Owner information
 * - Property details (acreage, address, geocode)
 * - Tax information
 */

import axios, { AxiosInstance } from 'axios';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { upsertParcel, closePool } from '../shared/db';
import { MONTANA_COUNTIES } from '@landfinder/shared';

// Montana Cadastral ArcGIS REST API endpoints
const CADASTRAL_BASE_URL = 'https://gis.dnrc.mt.gov/arcgis/rest/services';
const PARCEL_SERVICE = '/Cadastral/Cadastral_Parcels/MapServer/0';

interface ArcGISQueryParams {
  where: string;
  outFields: string;
  returnGeometry: boolean;
  geometryType?: string;
  spatialRel?: string;
  outSR?: number;
  f: string;
  resultOffset?: number;
  resultRecordCount?: number;
}

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
}

const s3Client = new S3Client({});

class MontanaCadastralScraper {
  private client: AxiosInstance;
  private bucket: string;

  constructor() {
    this.client = axios.create({
      baseURL: CADASTRAL_BASE_URL,
      timeout: 60000,
      headers: {
        'User-Agent': 'LandFinder/1.0 (Property Research Tool)',
      },
    });
    this.bucket = process.env.S3_BUCKET || 'landfinder-scraping';
  }

  async queryParcels(
    county: string,
    offset = 0,
    limit = 1000
  ): Promise<ArcGISResponse> {
    const params: ArcGISQueryParams = {
      where: `COUNTYNAME = '${county.toUpperCase()}'`,
      outFields: '*',
      returnGeometry: true,
      outSR: 4326, // WGS84 for lat/lng coordinates
      f: 'json',
      resultOffset: offset,
      resultRecordCount: limit,
    };

    const response = await this.client.get<ArcGISResponse>(
      `${PARCEL_SERVICE}/query`,
      { params }
    );

    return response.data;
  }

  async queryParcelsByAcreage(
    county: string,
    minAcres: number,
    maxAcres?: number,
    offset = 0,
    limit = 1000
  ): Promise<ArcGISResponse> {
    let whereClause = `COUNTYNAME = '${county.toUpperCase()}' AND ACRES >= ${minAcres}`;
    if (maxAcres) {
      whereClause += ` AND ACRES <= ${maxAcres}`;
    }

    const params: ArcGISQueryParams = {
      where: whereClause,
      outFields: '*',
      returnGeometry: true,
      outSR: 4326,
      f: 'json',
      resultOffset: offset,
      resultRecordCount: limit,
    };

    const response = await this.client.get<ArcGISResponse>(
      `${PARCEL_SERVICE}/query`,
      { params }
    );

    return response.data;
  }

  convertRingsToGeoJSON(rings: number[][][]): string {
    return JSON.stringify({
      type: 'Polygon',
      coordinates: rings,
    });
  }

  calculateCentroid(rings: number[][][]): { lat: number; lng: number } | null {
    if (!rings || rings.length === 0 || rings[0].length === 0) {
      return null;
    }

    const outerRing = rings[0];
    let sumLat = 0;
    let sumLng = 0;

    for (const point of outerRing) {
      sumLng += point[0];
      sumLat += point[1];
    }

    return {
      lat: sumLat / outerRing.length,
      lng: sumLng / outerRing.length,
    };
  }

  async processFeature(feature: ParcelFeature): Promise<string | null> {
    const { attributes, geometry } = feature;

    if (!attributes.PARCELID) {
      console.warn('Skipping feature without PARCELID');
      return null;
    }

    let latitude: number | null = null;
    let longitude: number | null = null;
    let boundaryGeoJson: string | null = null;

    if (geometry?.rings) {
      boundaryGeoJson = this.convertRingsToGeoJSON(geometry.rings);
      const centroid = this.calculateCentroid(geometry.rings);
      if (centroid) {
        latitude = centroid.lat;
        longitude = centroid.lng;
      }
    }

    const parcelId = await upsertParcel({
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

    return parcelId;
  }

  async scrapeCounty(county: string): Promise<{
    processed: number;
    errors: number;
  }> {
    console.log(`Starting scrape for ${county} County, MT`);

    let offset = 0;
    const limit = 1000;
    let processed = 0;
    let errors = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        console.log(`Fetching parcels ${offset} to ${offset + limit}...`);
        const response = await this.queryParcels(county, offset, limit);

        if (!response.features || response.features.length === 0) {
          hasMore = false;
          break;
        }

        for (const feature of response.features) {
          try {
            const parcelId = await this.processFeature(feature);
            if (parcelId) {
              processed++;
            }
          } catch (err) {
            console.error(
              `Error processing parcel ${feature.attributes?.PARCELID}:`,
              err
            );
            errors++;
          }
        }

        hasMore = response.exceededTransferLimit === true;
        offset += limit;

        // Rate limiting - be respectful to the API
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        console.error(`Error fetching parcels at offset ${offset}:`, err);
        errors++;
        hasMore = false;
      }
    }

    console.log(
      `Completed ${county} County: ${processed} processed, ${errors} errors`
    );

    return { processed, errors };
  }

  async scrapeAllCounties(): Promise<void> {
    const results: Record<string, { processed: number; errors: number }> = {};

    for (const county of MONTANA_COUNTIES) {
      try {
        results[county] = await this.scrapeCounty(county);
      } catch (err) {
        console.error(`Failed to scrape ${county} County:`, err);
        results[county] = { processed: 0, errors: 1 };
      }
    }

    // Save results summary to S3
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
        Bucket: this.bucket,
        Key: `cadastral/runs/${new Date().toISOString().split('T')[0]}.json`,
        Body: JSON.stringify(summary, null, 2),
        ContentType: 'application/json',
      })
    );

    console.log('Scrape complete:', summary.totals);
  }

  async scrapeLargeParcels(minAcres = 2): Promise<void> {
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
          const response = await this.queryParcelsByAcreage(
            county,
            minAcres,
            undefined,
            offset,
            limit
          );

          if (!response.features || response.features.length === 0) {
            hasMore = false;
            break;
          }

          for (const feature of response.features) {
            try {
              const parcelId = await this.processFeature(feature);
              if (parcelId) {
                totalProcessed++;
              }
            } catch (err) {
              console.error(
                `Error processing parcel ${feature.attributes?.PARCELID}:`,
                err
              );
              totalErrors++;
            }
          }

          hasMore = response.exceededTransferLimit === true;
          offset += limit;

          // Rate limiting
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
}

// Main entry point
async function main() {
  const scraper = new MontanaCadastralScraper();

  const mode = process.env.SCRAPE_MODE || 'large';

  try {
    if (mode === 'all') {
      await scraper.scrapeAllCounties();
    } else if (mode === 'large') {
      const minAcres = parseInt(process.env.MIN_ACRES || '2', 10);
      await scraper.scrapeLargeParcels(minAcres);
    } else if (mode === 'county') {
      const county = process.env.COUNTY;
      if (!county) {
        throw new Error('COUNTY environment variable required for county mode');
      }
      await scraper.scrapeCounty(county);
    }
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error('Scraper failed:', err);
  process.exit(1);
});

export { MontanaCadastralScraper };
