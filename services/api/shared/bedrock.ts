import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ListingStatus, ListingStatusConfidence } from '@lastbestland/shared';
import { env } from './env';
import { tracer } from './tracer';

const client = tracer.captureAWSv3Client(new BedrockRuntimeClient({}));

interface ClaudeResponse {
  content: Array<{ text: string }>;
}

async function invokeClaude(prompt: string, maxTokens: number): Promise<string> {
  const response = await client.send(
    new InvokeModelCommand({
      modelId: env.bedrockModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  );
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as ClaudeResponse;
  const text = parsed.content[0]?.text;
  if (!text) throw new Error('Bedrock returned empty content');
  return text;
}

export interface ParcelContext {
  county: string | null;
  acreage: number | null;
  address: string | null;
  waterRights: Array<{
    waterSource: string | null;
    waterType: string | null;
    flowRateGpm: number | null;
    volumeAcreFeet: number | null;
    priorityDate: string | null;
    status: string;
  }>;
  roadAccess: { hasPublicAccess: boolean; roadTypes: string[] } | null;
  electric: { hasServiceTerritory: boolean; utilityName: string | null; hasNearbyLine: boolean } | null;
  floodZones: Array<{ zone: string; isSpecialFloodHazardArea: boolean; riskLevel: string }>;
  wildfireRisk: string | null;
  mineSiteCount: number;
  conservationEasements: Array<{ holderName: string | null; restrictions: string | null }>;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function describeWaterRights(rights: ParcelContext['waterRights']): string {
  if (rights.length === 0) return 'No water rights are on file for this parcel.';
  return rights
    .map((right) =>
      `- ${right.waterType ?? 'unknown type'} right from ${right.waterSource ?? 'unknown source'}, ` +
      `priority date ${right.priorityDate ?? 'unknown'}, status: ${right.status}` +
      (right.flowRateGpm ? `, ${right.flowRateGpm} GPM` : '') +
      (right.volumeAcreFeet ? `, ${right.volumeAcreFeet} acre-feet/year` : '')
    )
    .join('\n');
}

function describeRoadAccess(road: ParcelContext['roadAccess']): string {
  if (!road) return 'Road access data not yet available.';
  if (road.hasPublicAccess) {
    return `Public road access confirmed (${road.roadTypes.join(', ') || 'road type unspecified'}).`;
  }
  return 'No public road detected. Legal access must be verified before purchase.';
}

function describeElectric(electric: ParcelContext['electric']): string {
  if (!electric) return 'Electric service data not yet available.';
  if (electric.hasServiceTerritory) {
    return `Within electric service territory${electric.utilityName ? ` (${electric.utilityName})` : ''}.`;
  }
  if (electric.hasNearbyLine) return 'No service territory mapped, but a transmission line is within 10 miles.';
  return 'No electric service territory or nearby transmission lines found. Off-grid power is likely required.';
}

function describeFlood(zones: ParcelContext['floodZones']): string {
  if (zones.length === 0) return 'No FEMA flood zone overlay.';
  if (zones.some((zone) => zone.isSpecialFloodHazardArea)) {
    return `Parcel is in a Special Flood Hazard Area (${zones.map((zone) => zone.zone).join(', ')}). Federal flood insurance may be required.`;
  }
  return `Flood zone present: ${zones.map((zone) => `Zone ${zone.zone} (${zone.riskLevel} risk)`).join(', ')}.`;
}

function describeEasements(easements: ParcelContext['conservationEasements']): string {
  if (easements.length === 0) return 'No conservation easements found in the NCED database.';
  const holders = easements.map((easement) => easement.holderName).filter(Boolean).join(', ');
  return `${plural(easements.length, 'conservation easement')} found${holders ? ` (held by ${holders})` : ''}. Development and subdivision rights may be restricted.`;
}

export async function generateBuildabilitySummary(parcel: ParcelContext): Promise<string> {
  const prompt = `You are a land analyst specializing in rural Montana real estate. Write a concise buildability and due diligence summary for a land parcel based on the data below. Focus on what a buyer needs to know before making an offer, especially anything that could block construction, limit use, or require costly remediation. Be direct and factual. Flag missing information as unknown rather than speculating. Write 3 to 5 sentences in plain prose with no bullet points and no headers.

Parcel details:
- County: ${parcel.county ?? 'unknown'}
- Acreage: ${parcel.acreage ?? 'unknown'}
- Address/location: ${parcel.address ?? 'not specified'}

Water rights:
${describeWaterRights(parcel.waterRights)}

Road access:
${describeRoadAccess(parcel.roadAccess)}

Electric service:
${describeElectric(parcel.electric)}

Flood risk:
${describeFlood(parcel.floodZones)}

Wildfire risk:
${parcel.wildfireRisk ? `FEMA NRI wildfire risk: ${parcel.wildfireRisk}.` : 'Wildfire risk rating not available.'}

Mine sites:
${parcel.mineSiteCount === 0 ? 'No mine sites within 10 miles.' : `${plural(parcel.mineSiteCount, 'USGS-recorded mine site')} within 10 miles. Environmental assessment recommended.`}

Conservation easements:
${describeEasements(parcel.conservationEasements)}

Write the summary now:`;

  return invokeClaude(prompt, 512);
}

export interface WebSearchResultItem {
  title: string;
  snippet: string;
  link: string;
}

export type ListingStatusCheck = Omit<ListingStatus, 'parcelId' | 'fetchedAt'>;

const NO_RESULTS: ListingStatusCheck = {
  forSale: false,
  confidence: 'low',
  price: null,
  listingUrl: null,
  source: null,
  summary: 'No search results found for this address.',
};

/**
 * Parses the JSON object Claude returns for a listing status check, coercing
 * each field so a malformed response degrades to "not for sale, low
 * confidence" instead of throwing.
 */
export function parseListingStatusResponse(text: string): ListingStatusCheck {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Bedrock response did not contain a JSON object');
  const data = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const confidence: ListingStatusConfidence =
    data.confidence === 'high' || data.confidence === 'medium' ? data.confidence : 'low';
  return {
    forSale: Boolean(data.forSale),
    confidence,
    price: typeof data.price === 'number' ? data.price : null,
    listingUrl: typeof data.listingUrl === 'string' ? data.listingUrl : null,
    source: typeof data.source === 'string' ? data.source : null,
    summary: typeof data.summary === 'string' ? data.summary : '',
  };
}

/**
 * Classifies whether a property is for sale from search results that were
 * already fetched. The model only reasons over the snippets it is given, so it
 * cannot introduce a price or URL that is not in them.
 */
export async function checkListingStatusFromSearchResults(
  address: string,
  results: WebSearchResultItem[]
): Promise<ListingStatusCheck> {
  if (results.length === 0) return NO_RESULTS;

  const resultsText = results
    .map((result, i) => `${i + 1}. ${result.title}\n${result.snippet}\nURL: ${result.link}`)
    .join('\n\n');

  const prompt = `You are a real estate research assistant. Based ONLY on the search results below, determine whether this property is currently listed for sale: ${address}

Search results:
${resultsText}

Respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"forSale": boolean, "confidence": "high"|"medium"|"low", "price": number|null, "listingUrl": string|null, "source": string|null, "summary": string}

Rules:
- Only set forSale to true if a result clearly indicates an active listing (for example "for sale", a dollar amount, or a listing site like Zillow, LandWatch, Realtor.com, Land.com, or a real estate brokerage).
- Never invent a price, URL, or source that is not directly stated in the search results.
- If you cannot confirm it is for sale from these results, set forSale to false and confidence to "low".
- summary must be exactly one sentence describing what you found or did not find.`;

  return parseListingStatusResponse(await invokeClaude(prompt, 400));
}
