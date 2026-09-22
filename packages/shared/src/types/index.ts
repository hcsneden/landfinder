// Core data types for Last Best Land

export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface Parcel {
  id: string;
  state: string;
  county: string | null;
  parcelNumber: string | null;
  geoId: string | null;
  address: string | null;
  acreage: number | null;
  coordinates: {
    latitude: number;
    longitude: number;
  } | null;
  boundary: GeoJSONPolygon | null;
  buildingValue: number | null;
  propType: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface WaterRight {
  id: string;
  parcelId: string;
  waterRightNumber: string | null;
  waterSource: string | null;
  waterType: 'surface' | 'groundwater' | 'mixed' | null;
  flowRate: number | null; // gallons per minute
  volume: number | null; // acre-feet
  priorityDate: string | null;
  status: 'active' | 'inactive' | 'pending' | 'unknown';
  rawData: Record<string, unknown>;
  createdAt: string;
}

export interface Listing {
  id: string;
  parcelId: string | null;
  source: ListingSource;
  sourceId: string;
  price: number | null;
  listingUrl: string;
  description: string | null;
  images: string[];
  listedAt: string | null;
  scrapedAt: string;
  rawData: Record<string, unknown>;
}

export type ListingSource =
  | 'landwatch'
  | 'land.com'
  | 'montana_land_source'
  | 'hall_hall'
  | 'fay_ranches'
  | 'landandfarm';

export interface ParcelInsight {
  id: string;
  parcelId: string;
  insightType: InsightType;
  content: string;
  modelVersion: string;
  createdAt: string;
}

export type InsightType =
  | 'summary'
  | 'water_analysis'
  | 'due_diligence'
  | 'comparable_properties'
  | 'potential_issues';

export interface User {
  id: string; // Cognito sub
  email: string;
  createdAt: string;
}

export interface SavedParcel {
  userId: string;
  parcelId: string;
  notes: string | null;
  savedAt: string;
}

export interface HuntingDistrict {
  id: string;
  districtNumber: string;
  species: string;
  rawData: Record<string, unknown>;
}

export interface StreamGaugeReading {
  date: string;
  meanFlowCfs: number;
}

export type RoadType =
  | 'highway'   // Interstate, US/state highway (MTFCC S1100)
  | 'county'    // County/secondary road (MTFCC S1200)
  | 'local'     // Local/neighborhood road (MTFCC S1400)
  | 'trail'     // 4WD vehicular trail (MTFCC S1500 or USFS maint level 1-2)
  | 'forest'    // USFS managed road (maint level 3-5)
  | 'blm'       // BLM managed road
  | 'unknown';

export interface RoadSegment {
  name: string | null;
  type: RoadType;
  source: 'tiger' | 'blm' | 'usfs';
  surfaceType: string | null;
  maintLevel: number | null;  // USFS maintenance level 1–5; null for TIGER/BLM
}

export interface RoadAccess {
  parcelId: string;
  segments: RoadSegment[];
  hasPublicAccess: boolean;
  fetchedAt: string;
}

export interface StreamGauge {
  id: string;
  siteNumber: string;
  siteName: string;
  streamName: string | null;
  distanceMiles: number;
  latestFlowCfs: number | null;
  latestReadingDate: string | null;
  readings: StreamGaugeReading[];
  // Keyed by month number (1-12) -> average CFS for that calendar month across all cached readings
  monthlyAveragesCfs: Record<number, number>;
}

export interface ConservationEasement {
  holderName: string | null;
  purpose: string | null;
  dateRecorded: string | null;
  restrictions: string | null;
  acreage: number | null;
}

// Search types
export interface SearchCriteria {
  state: string;
  county?: string;
  minAcreage?: number;
  maxAcreage?: number;
  minPrice?: number;
  maxPrice?: number;
  waterRightsRequired?: boolean;
  propertyType?: PropertyType[];
  bbox?: BBox;
}

export type PropertyType =
  | 'residential'
  | 'agricultural'
  | 'recreational'
  | 'commercial'
  | 'timber'
  | 'ranch';

export interface SearchResult {
  parcel: Parcel;
  listing: Listing | null;
  hasWaterRights: boolean;
  previewInsight: string | null;
  // For-sale signal derived per parcel rather than from an aggregated listing feed.
  // Null means not yet checked, which is not the same as not for sale: the search
  // worker only checks a bounded number of uncached parcels per run.
  listingStatus: SearchListingStatus | null;
}

// The parts of ListingStatus worth carrying in a result set. The full record,
// including the summary text, comes from GET /parcels/{id}/listing-status.
export interface SearchListingStatus {
  forSale: boolean;
  confidence: ListingStatusConfidence;
  price: number | null;
  listingUrl: string | null;
  source: string | null;
}

export interface SearchJob {
  id: string;
  criteria: SearchCriteria;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  resultCount: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ParcelCandidate {
  parcelId: string;
  address: string | null;
  acreage: number | null;
  county: string | null;
  subdivision: string | null;
  totalValue: number | null;
  // Only populated for the first ~10 candidates — null means "not checked", not "not for sale"
  forSale: boolean | null;
  listingSummary: string | null;
}

export type ListingStatusConfidence = 'high' | 'medium' | 'low';

export interface ListingStatus {
  parcelId: string;
  forSale: boolean;
  confidence: ListingStatusConfidence;
  price: number | null;
  listingUrl: string | null;
  source: string | null;
  summary: string;
  fetchedAt: string;
}

export interface ParcelCandidates {
  candidates: ParcelCandidate[];
  roadName: string;
}

// API response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface BroadbandProvider {
  providerName: string;
  techType: string;
  maxDownloadSpeed: number | null;
  maxUploadSpeed: number | null;
}

export interface ElectricAccess {
  hasNearbyLine: boolean;
  nearestLineDistanceMiles: number | null;
  voltageClass: string | null;
  type: string | null;
  owner: string | null;
  serviceTerritory: {
    utilityName: string;
    utilityType: string | null;
  } | null;
}

export interface UtilityAccess {
  parcelId: string;
  electric: ElectricAccess | null;
  broadband: BroadbandProvider[];
  // False when no broadband source is wired up, so the UI can say "no data" rather
  // than "no providers". The FCC's public point lookup was retired and its
  // replacement is a credentialed bulk download, so this is false for now.
  broadbandDataAvailable: boolean;
  fetchedAt: string;
}

// Soil (NRCS SSURGO via Soil Data Access) --------------------------------

export interface SoilMapUnit {
  mukey: string;
  name: string | null;            // map unit name, e.g. "Amsterdam silt loam, 2 to 4 percent slopes"
  acresInParcel: number | null;   // acreage of this map unit inside the parcel
  percentOfParcel: number | null; // share of parcel covered, 0-100
  farmlandClass: string | null;   // e.g. "All areas are prime farmland", "Not prime farmland"
  drainageClass: string | null;   // dominant component drainage, e.g. "Well drained"
  taxonomicClass: string | null;  // dominant component taxonomy (taxclname)
  slopePercent: number | null;    // representative slope of dominant component
  capabilityClass: string | null; // non-irrigated land capability class, e.g. "3e"
}

export interface SoilInfo {
  parcelId: string;
  mapUnits: SoilMapUnit[];
  // Convenience roll-ups computed from the map units:
  primeFarmlandPercent: number | null; // % of parcel that is prime / prime-if-* farmland
  dominantMapUnitName: string | null;  // name of the largest map unit by area
  fetchedAt: string;
}

// Groundwater / wells (MBMG GWIC) ----------------------------------------

export interface WellLog {
  gwicId: string;
  siteName: string | null;
  distanceMiles: number;
  totalDepthFt: number | null;      // total drilled depth
  staticWaterLevelFt: number | null; // static water level below ground surface
  yieldGpm: number | null;           // reported yield, gallons per minute
  aquifer: string | null;
  wellUse: string | null;            // e.g. "domestic", "stock", "irrigation"
  dateCompleted: string | null;
}

export interface GroundwaterInfo {
  parcelId: string;
  searchRadiusMiles: number;
  wells: WellLog[];
  // Roll-ups across the nearby wells, useful as a "can I get water here" signal:
  wellCount: number;
  medianDepthFt: number | null;
  medianYieldGpm: number | null;
  medianStaticWaterLevelFt: number | null;
  fetchedAt: string;
}

export type FloodRiskLevel = 'high' | 'moderate' | 'minimal' | 'undetermined';

export interface FloodZone {
  zone: string;
  subtype: string | null;
  isSpecialFloodHazardArea: boolean;
  riskLevel: FloodRiskLevel;
}

export type WildfireRiskRating = 'Very High' | 'High' | 'Medium' | 'Low' | 'Very Low';

// Fields follow the USGS hosted MRDS "compact" service, which is all that survived
// the retirement of the mrdata.usgs.gov ArcGIS REST endpoint. Deposit, work and
// operation type are not published by any live MRDS query service any more.
export interface MineSite {
  name: string | null;
  devStatus: string | null;
  commodities: string | null;
  url: string | null;
}

export interface EnvironmentalRisk {
  parcelId: string;
  floodZones: FloodZone[];
  wildfireRisk: WildfireRiskRating | null;
  mineSites: MineSite[];
  fetchedAt: string;
}

// Auth types
export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}
