const SQUARE_FEET_PER_ACRE = 43_560;

const usdWholeDollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function formatAcreage(acreage: number | null): string {
  if (acreage === null) return 'N/A';
  if (acreage < 1) return `${Math.round(acreage * SQUARE_FEET_PER_ACRE)} sq ft`;
  return `${acreage.toLocaleString()} acres`;
}

export function formatPrice(price: number | null): string {
  if (price === null) return 'Contact for price';
  return usdWholeDollars.format(price);
}

export function formatPricePerAcre(price: number | null, acreage: number | null): string {
  if (price === null || acreage === null || acreage === 0) return 'N/A';
  return `${formatPrice(price / acreage)}/acre`;
}

export function formatDate(dateString: string | null): string {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const WATER_TYPE_LABELS: Record<string, string> = {
  surface: 'Surface Water',
  groundwater: 'Groundwater',
  mixed: 'Mixed (Surface & Ground)',
};

export function formatWaterType(type: string | null): string {
  if (!type) return 'Unknown';
  return WATER_TYPE_LABELS[type] ?? type;
}

export function formatFlowRate(gpm: number | null): string {
  if (gpm === null) return 'N/A';
  return `${gpm.toLocaleString()} GPM`;
}

export function formatVolume(acreFeet: number | null): string {
  if (acreFeet === null) return 'N/A';
  return `${acreFeet.toLocaleString()} acre-feet`;
}

export const MONTANA_COUNTIES = [
  'Beaverhead', 'Big Horn', 'Blaine', 'Broadwater', 'Carbon', 'Carter', 'Cascade',
  'Chouteau', 'Custer', 'Daniels', 'Dawson', 'Deer Lodge', 'Fallon', 'Fergus',
  'Flathead', 'Gallatin', 'Garfield', 'Glacier', 'Golden Valley', 'Granite',
  'Hill', 'Jefferson', 'Judith Basin', 'Lake', 'Lewis and Clark', 'Liberty',
  'Lincoln', 'Madison', 'McCone', 'Meagher', 'Mineral', 'Missoula', 'Musselshell',
  'Park', 'Petroleum', 'Phillips', 'Pondera', 'Powder River', 'Powell', 'Prairie',
  'Ravalli', 'Richland', 'Roosevelt', 'Rosebud', 'Sanders', 'Sheridan',
  'Silver Bow', 'Stillwater', 'Sweet Grass', 'Teton', 'Toole', 'Treasure',
  'Valley', 'Wheatland', 'Wibaux', 'Yellowstone',
] as const;
