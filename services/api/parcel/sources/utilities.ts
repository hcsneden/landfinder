import type { ElectricAccess, ServiceTerritory, UtilityAccess } from '@lastbestland/shared';
import { queryArcGis, polygonGeometryParams, pointGeometryParams, stringAttribute } from '../../shared/arcgis';
import { withParcelCache, parcelSearchArea, days } from '../../shared/parcelCache';
import { logger } from '../../shared/logger';

const TTL_MS = days(30);
const SEARCH_RADIUS_METERS = 16_093; // 10 miles

// HIFLD (Homeland Infrastructure Foundation-Level Data) electric layers.
const TRANSMISSION_LINES_URL = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Power_Transmission_Lines/FeatureServer/0/query';
const SERVICE_TERRITORIES_URL = 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Electric_Retail_Service_Territories/FeatureServer/0/query';

interface TransmissionLine {
  voltageClass: string | null;
  lineType: string | null;
  owner: string | null;
}

async function fetchNearestTransmissionLine(rings: number[][][]): Promise<TransmissionLine | null> {
  const features = await queryArcGis(TRANSMISSION_LINES_URL, {
    ...polygonGeometryParams(rings),
    outFields: 'VOLT_CLASS,TYPE,OWNER',
    resultRecordCount: '1',
    returnGeometry: 'false',
  });
  const first = features[0]?.attributes;
  if (!first) return null;
  return {
    voltageClass: stringAttribute(first.VOLT_CLASS),
    lineType: stringAttribute(first.TYPE),
    owner: stringAttribute(first.OWNER),
  };
}

async function fetchServiceTerritory(lat: number, lon: number): Promise<ServiceTerritory | null> {
  const features = await queryArcGis(SERVICE_TERRITORIES_URL, {
    ...pointGeometryParams(lat, lon),
    outFields: 'NAME,TYPE',
    resultRecordCount: '1',
    returnGeometry: 'false',
  });
  const utilityName = stringAttribute(features[0]?.attributes.NAME);
  if (!utilityName) return null;
  return { utilityName, utilityType: stringAttribute(features[0]?.attributes.TYPE) };
}

async function fetchElectricAccess(parcelId: string): Promise<ElectricAccess> {
  const area = await parcelSearchArea(parcelId, SEARCH_RADIUS_METERS, SEARCH_RADIUS_METERS);
  if (!area) throw new Error('Parcel has no location');

  const [line, territory] = await Promise.allSettled([
    fetchNearestTransmissionLine(area.rings),
    fetchServiceTerritory(area.lat, area.lon),
  ]);
  if (line.status === 'rejected') logger.warn('HIFLD transmission line query failed', { error: String(line.reason) });
  if (territory.status === 'rejected') logger.warn('HIFLD service territory query failed', { error: String(territory.reason) });
  if (line.status === 'rejected' && territory.status === 'rejected') throw new Error('All electric sources failed');

  const nearestLine = line.status === 'fulfilled' ? line.value : null;
  return {
    hasNearbyLine: nearestLine !== null,
    voltageClass: nearestLine?.voltageClass ?? null,
    lineType: nearestLine?.lineType ?? null,
    owner: nearestLine?.owner ?? null,
    serviceTerritory: territory.status === 'fulfilled' ? territory.value : null,
  };
}

export async function getUtilities(parcelId: string, forceRefresh: boolean): Promise<UtilityAccess | null> {
  const cached = await withParcelCache('utilities', parcelId, TTL_MS, forceRefresh, () => fetchElectricAccess(parcelId));
  if (!cached) return null;
  return { parcelId, electric: cached.payload, fetchedAt: cached.fetchedAt };
}
