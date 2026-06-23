// Utility functions shared across packages

export function formatAcreage(acreage: number | null): string {
  if (acreage === null) return 'N/A';
  if (acreage < 1) {
    return `${(acreage * 43560).toFixed(0)} sq ft`;
  }
  return `${acreage.toLocaleString()} acres`;
}

export function formatPrice(price: number | null): string {
  if (price === null) return 'Contact for price';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(price);
}

export function formatPricePerAcre(price: number | null, acreage: number | null): string {
  if (price === null || acreage === null || acreage === 0) return 'N/A';
  const pricePerAcre = price / acreage;
  return `${formatPrice(pricePerAcre)}/acre`;
}

export function formatDate(dateString: string | null): string {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatWaterType(type: string | null): string {
  if (!type) return 'Unknown';
  const labels: Record<string, string> = {
    surface: 'Surface Water',
    groundwater: 'Groundwater',
    mixed: 'Mixed (Surface & Ground)',
  };
  return labels[type] || type;
}

export function formatFlowRate(rate: number | null): string {
  if (rate === null) return 'N/A';
  return `${rate.toLocaleString()} GPM`;
}

export function formatVolume(volume: number | null): string {
  if (volume === null) return 'N/A';
  return `${volume.toLocaleString()} acre-feet`;
}

export function getListingSourceLabel(source: string): string {
  const labels: Record<string, string> = {
    landwatch: 'LandWatch',
    'land.com': 'Land.com',
    montana_land_source: 'Montana Land Source',
    hall_hall: 'Hall and Hall',
    fay_ranches: 'Fay Ranches',
    landandfarm: 'Land And Farm',
  };
  return labels[source] || source;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

export function generateSearchId(): string {
  return `search_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Montana county list for search filters
export const MONTANA_COUNTIES = [
  'Beaverhead', 'Big Horn', 'Blaine', 'Broadwater', 'Carbon', 'Carter', 'Cascade',
  'Chouteau', 'Custer', 'Daniels', 'Dawson', 'Deer Lodge', 'Fallon', 'Fergus',
  'Flathead', 'Gallatin', 'Garfield', 'Glacier', 'Golden Valley', 'Granite',
  'Hill', 'Jefferson', 'Judith Basin', 'Lake', 'Lewis and Clark', 'Liberty',
  'Lincoln', 'Madison', 'McCone', 'Meagher', 'Mineral', 'Missoula', 'Musselshell',
  'Park', 'Petroleum', 'Phillips', 'Pondera', 'Powder River', 'Powell', 'Prairie',
  'Ravalli', 'Richland', 'Roosevelt', 'Rosebud', 'Sanders', 'Sheridan',
  'Silver Bow', 'Stillwater', 'Sweet Grass', 'Teton', 'Toole', 'Treasure',
  'Valley', 'Wheatland', 'Wibaux', 'Yellowstone'
] as const;

export type MontanaCounty = typeof MONTANA_COUNTIES[number];
