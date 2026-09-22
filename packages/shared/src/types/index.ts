export interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface GeoJSONPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface Parcel {
  id: string;
  state: string;
  county: string | null;
  parcelNumber: string | null;
  geoId: string | null;
  address: string | null;
  acreage: number | null;
  coordinates: { latitude: number; longitude: number } | null;
  boundary: GeoJSONPolygon | null;
  buildingValue: number | null;
  propType: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WaterType = 'surface' | 'groundwater' | 'mixed';
export type WaterRightStatus = 'active' | 'inactive' | 'pending' | 'unknown';

export interface WaterRight {
  id: string;
  parcelId: string;
  waterRightNumber: string | null;
  waterSource: string | null;
  waterType: WaterType | null;
  flowRateGpm: number | null;
  volumeAcreFeet: number | null;
  priorityDate: string | null;
  status: WaterRightStatus;
  rawData: Record<string, unknown>;
  createdAt: string;
}

export interface ParcelInsight {
  id: string;
  parcelId: string;
  insightType: 'summary';
  content: string;
  modelVersion: string;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
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
}

export interface StreamGaugeReading {
  date: string;
  meanFlowCfs: number;
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
  /** Average CFS per calendar month, keyed 1 through 12. */
  monthlyAveragesCfs: Record<number, number>;
}

export type RoadType = 'highway' | 'county' | 'local' | 'trail' | 'forest' | 'blm' | 'unknown';

export interface RoadSegment {
  name: string | null;
  type: RoadType;
  source: 'tiger' | 'blm' | 'usfs';
  surfaceType: string | null;
  /** USFS operational maintenance level 1 through 5. Null for other sources. */
  maintLevel: number | null;
}

export interface RoadAccess {
  parcelId: string;
  segments: RoadSegment[];
  hasPublicAccess: boolean;
  fetchedAt: string;
}

export interface ServiceTerritory {
  utilityName: string;
  utilityType: string | null;
}

export interface ElectricAccess {
  hasNearbyLine: boolean;
  voltageClass: string | null;
  lineType: string | null;
  owner: string | null;
  serviceTerritory: ServiceTerritory | null;
}

export interface UtilityAccess {
  parcelId: string;
  electric: ElectricAccess;
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

export interface ConservationEasement {
  holderName: string | null;
  purpose: string | null;
  dateRecorded: string | null;
  restrictions: string | null;
  acreage: number | null;
}

export interface ConservationEasements {
  parcelId: string;
  easements: ConservationEasement[];
  fetchedAt: string;
}

export interface SoilMapUnit {
  mukey: string;
  name: string | null;
  farmlandClass: string | null;
  drainageClass: string | null;
  taxonomicClass: string | null;
  slopePercent: number | null;
  capabilityClass: string | null;
}

export interface SoilInfo {
  parcelId: string;
  mapUnits: SoilMapUnit[];
  /** Share of map units rated prime farmland, by unit count rather than area. */
  primeFarmlandPercent: number | null;
  fetchedAt: string;
}

export interface WellLog {
  gwicId: string;
  siteName: string | null;
  distanceMiles: number;
  totalDepthFt: number | null;
  staticWaterLevelFt: number | null;
  yieldGpm: number | null;
  aquifer: string | null;
  wellUse: string | null;
  dateCompleted: string | null;
}

export interface GroundwaterInfo {
  parcelId: string;
  searchRadiusMiles: number;
  wells: WellLog[];
  wellCount: number;
  medianDepthFt: number | null;
  medianYieldGpm: number | null;
  medianStaticWaterLevelFt: number | null;
  fetchedAt: string;
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

export type SearchListingStatus = Pick<
  ListingStatus,
  'forSale' | 'confidence' | 'price' | 'listingUrl' | 'source'
>;

export interface SearchCriteria {
  state: string;
  county?: string;
  minAcreage?: number;
  maxAcreage?: number;
  minPrice?: number;
  maxPrice?: number;
  waterRightsRequired?: boolean;
  bbox?: BBox;
}

export interface SearchResult {
  parcel: Parcel;
  hasWaterRights: boolean;
  previewInsight: string | null;
  /**
   * Null means the parcel has not been checked yet. The search worker checks a
   * bounded number of uncached parcels per run.
   */
  listingStatus: SearchListingStatus | null;
}

export type SearchJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface SearchJob {
  id: string;
  criteria: SearchCriteria;
  status: SearchJobStatus;
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
  /** Null means not checked. Only the first few candidates are checked. */
  forSale: boolean | null;
  listingSummary: string | null;
}

export interface ParcelCandidates {
  candidates: ParcelCandidate[];
  roadName: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface PaginatedResponse<T> {
  items: T[];
  totalCount: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface AuthTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthSession {
  tokens: AuthTokens;
  user: User;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export type RegisterRequest = LoginRequest;

export interface RefreshRequest {
  refreshToken: string;
}
