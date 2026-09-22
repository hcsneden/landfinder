// Address text helpers for the parcel lookup. Listing sites and Montana's
// address data disagree on abbreviations, house numbers, and lot numbers, so
// the lookup tries several spellings of the same address.

const FULL_TO_ABBREVIATION: Record<string, string> = {
  road: 'rd', street: 'st', avenue: 'ave', lane: 'ln', drive: 'dr',
  boulevard: 'blvd', court: 'ct', place: 'pl', highway: 'hwy', circle: 'cir',
  terrace: 'ter', parkway: 'pkwy', trail: 'trl', crossing: 'xing', junction: 'jct',
  meadows: 'mdws', creek: 'crk', view: 'vw', springs: 'spgs', spring: 'spg',
  heights: 'hts', valley: 'vly', ranch: 'rnch', village: 'vlg', lake: 'lk',
  lakes: 'lks', point: 'pt', ridge: 'rdg', summit: 'smt', station: 'sta',
  landing: 'lndg', estates: 'est', canyon: 'cyn', cove: 'cv', fork: 'frk',
  forks: 'frks', glen: 'gln', hill: 'hl', hills: 'hls', hollow: 'holw',
  knoll: 'knl', knolls: 'knls', mount: 'mt', mountain: 'mtn', plains: 'plns',
  river: 'riv', shores: 'shrs', vista: 'vis',
};

const ABBREVIATION_TO_FULL: Record<string, string> = Object.fromEntries(
  Object.entries(FULL_TO_ABBREVIATION).map(([full, abbreviation]) => [abbreviation, full])
);

const STREET_SUFFIX = /\s+(rd|road|st|street|ave|avenue|ln|lane|dr|drive|way|blvd|ct|court|pl|place|hwy|highway|loop|trl|trail|run|cir|circle|pike|row)\.?$/i;
const NO_HOUSE_NUMBER_PREFIX = /^\s*(nhn|tbd|0)\s+/i;
const LOT_NUMBER_SUFFIX = /\s+lot\s*#?\s*(\d+)\s*$/i;

// Replaces whole alphabetic words only, so ordinals like "1st" keep their suffix.
function replaceWords(text: string, map: Record<string, string>): string {
  return text.replace(/\b[A-Za-z]+\b/g, (word) => map[word.toLowerCase()] ?? word);
}

/** Returns the text, its fully spelled-out form, and its fully abbreviated form, deduplicated. */
export function addressVariants(text: string): string[] {
  const variants = [text, replaceWords(text, ABBREVIATION_TO_FULL), replaceWords(text, FULL_TO_ABBREVIATION)]
    .map((variant) => variant.trim())
    .filter(Boolean);
  return [...new Set(variants)];
}

export function streetPart(address: string): string {
  return (address.split(',')[0] ?? address).trim();
}

export function cityPart(address: string): string {
  return address.split(',')[1]?.trim() ?? '';
}

export interface AddressParts {
  street: string;
  city: string;
  state: string;
  zip?: string;
}

/** Parses "123 Main St, City, ST 12345" or "123 Main St, City, ST". */
export function parseAddressParts(address: string): AddressParts | null {
  const parts = address.split(',').map((part) => part.trim());
  const [street, city, stateZip = ''] = parts;
  if (parts.length < 3 || !street || !city) return null;
  const match = stateZip.match(/^([A-Za-z]{2})\s*(\d{5})?/);
  if (!match) return null;
  return { street, city, state: match[1]!, zip: match[2] };
}

export interface StreetNumber {
  number: number;
  /** Street name without its type suffix, matching how Montana address points store it. */
  name: string;
}

export function parseStreetNumber(street: string): StreetNumber | null {
  const match = street.match(/^(\d+)\s+(.+)/);
  if (!match) return null;
  const number = Number.parseInt(match[1]!, 10);
  const name = match[2]!.replace(STREET_SUFFIX, '').trim();
  return number > 0 && name ? { number, name } : null;
}

/** True for addresses like "TBD Foo Rd" or "0 Foo Rd" that carry no house number. */
export function hasNoHouseNumber(address: string): boolean {
  return NO_HOUSE_NUMBER_PREFIX.test(address);
}

/**
 * Rewrites "Nhn Foo Rd Lot 69" to "69 Foo Rd". Rural subdivision listings use
 * the lot number, while county records assign it as the house number.
 */
export function lotNumberAsHouseNumber(address: string): string | null {
  const street = streetPart(address);
  if (/^\s*\d+\s+/.test(street)) return null;
  const match = street.match(/^(.*?)\s+lot\s*#?\s*(\d+)\s*$/i);
  if (!match) return null;
  const road = match[1]!.replace(NO_HOUSE_NUMBER_PREFIX, '').trim();
  if (!road) return null;
  return `${match[2]} ${road}${address.slice(street.length)}`;
}

/** Strips the house number, lot number, and TBD prefix, leaving the road name. */
export function roadName(address: string): string | null {
  const road = streetPart(address)
    .replace(/^\s*\d+\s+/, '')
    .replace(NO_HOUSE_NUMBER_PREFIX, '')
    .replace(LOT_NUMBER_SUFFIX, '')
    .trim();
  return road.length >= 3 ? road : null;
}
