// Core data types for LandFinder

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
}

export interface SearchJob {
  id: string;
  criteria: SearchCriteria;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  resultCount: number | null;
  createdAt: string;
  completedAt: string | null;
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

// Auth types
export interface AuthTokens {
  accessToken: string;
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
