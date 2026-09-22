import type { ConservationEasement, ConservationEasements } from '@lastbestland/shared';
import { queryArcGis, envelopeGeometryParams, stringAttribute, numberAttribute } from '../../shared/arcgis';
import { withParcelCache, parcelSearchArea, days } from '../../shared/parcelCache';

const TTL_MS = days(30);
const SEARCH_RADIUS_METERS = 4_800; // about 3 miles

// National Conservation Easement Database, hosted on ArcGIS Online.
const NCED_URL = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Conservation_Easements_WFL1/FeatureServer/0/query';

async function fetchEasements(parcelId: string): Promise<ConservationEasement[]> {
  const area = await parcelSearchArea(parcelId, SEARCH_RADIUS_METERS, SEARCH_RADIUS_METERS);
  if (!area) throw new Error('Parcel has no location');

  const features = await queryArcGis(NCED_URL, {
    ...envelopeGeometryParams(area.rings),
    outFields: 'holderName,purpose,dateRecorded,restrictions,gisAcres',
    resultRecordCount: '20',
    returnGeometry: 'false',
  });
  return features.map(({ attributes }) => {
    const acres = numberAttribute(attributes.gisAcres);
    return {
      holderName: stringAttribute(attributes.holderName),
      purpose: stringAttribute(attributes.purpose),
      dateRecorded: stringAttribute(attributes.dateRecorded),
      restrictions: stringAttribute(attributes.restrictions),
      acreage: acres === null ? null : Math.round(acres),
    };
  });
}

export async function getConservationEasements(parcelId: string, forceRefresh: boolean): Promise<ConservationEasements | null> {
  const cached = await withParcelCache('conservation_easements', parcelId, TTL_MS, forceRefresh, () => fetchEasements(parcelId));
  if (!cached) return null;
  return { parcelId, easements: cached.payload, fetchedAt: cached.fetchedAt };
}
