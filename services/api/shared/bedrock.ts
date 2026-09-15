import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { tracer } from './tracer';

const client = tracer.captureAWSv3Client(new BedrockRuntimeClient({}));

export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ??
  'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface ParcelContext {
  county: string | null;
  acreage: number | null;
  address: string | null;
  waterRights: Array<{
    waterSource: string | null;
    waterType: string | null;
    flowRate: number | null;
    volume: number | null;
    priorityDate: string | null;
    status: string;
  }>;
  roadAccess: {
    hasPublicAccess: boolean;
    roadTypes: string[];
  } | null;
  electric: {
    hasServiceTerritory: boolean;
    utilityName: string | null;
    hasNearbyLine: boolean;
  } | null;
  broadband: Array<{ techType: string; maxDownloadSpeed: number | null }>;
  floodZones: Array<{ zone: string; isSpecialFloodHazardArea: boolean; riskLevel: string }>;
  wildfireRisk: string | null;
  mineSiteCount: number;
  conservationEasements: Array<{ holderName: string | null; restrictions: string | null }>;
}

export async function generateBuildabilitySummary(
  parcel: ParcelContext
): Promise<string> {
  const waterSection =
    parcel.waterRights.length === 0
      ? 'No water rights are on file for this parcel.'
      : parcel.waterRights
          .map(
            (wr) =>
              `- ${wr.waterType ?? 'unknown type'} right from ${wr.waterSource ?? 'unknown source'}, ` +
              `priority date ${wr.priorityDate ?? 'unknown'}, status: ${wr.status}` +
              (wr.flowRate ? `, ${wr.flowRate} GPM` : '') +
              (wr.volume ? `, ${wr.volume} acre-feet/year` : '')
          )
          .join('\n');

  const roadSection = parcel.roadAccess == null
    ? 'Road access data not yet available.'
    : parcel.roadAccess.hasPublicAccess
      ? `Public road access confirmed (${parcel.roadAccess.roadTypes.join(', ') || 'road type unspecified'}).`
      : 'No public road detected — legal access must be verified before purchase.';

  const electricSection = parcel.electric == null
    ? 'Electric service data not yet available.'
    : parcel.electric.hasServiceTerritory
      ? `Within electric service territory${parcel.electric.utilityName ? ` (${parcel.electric.utilityName})` : ''}.`
      : parcel.electric.hasNearbyLine
        ? 'No service territory mapped, but a transmission line is within 10 miles.'
        : 'No electric service territory or nearby transmission lines found — off-grid power likely required.';

  const broadbandSection = parcel.broadband.length === 0
    ? 'No broadband providers reported at this location.'
    : `Broadband available: ${parcel.broadband.map((b) => b.techType + (b.maxDownloadSpeed ? ` (${b.maxDownloadSpeed} Mbps)` : '')).join(', ')}.`;

  const floodSection = parcel.floodZones.length === 0
    ? 'No FEMA flood zone overlay.'
    : parcel.floodZones.some((z) => z.isSpecialFloodHazardArea)
      ? `Parcel is in a Special Flood Hazard Area (${parcel.floodZones.map((z) => z.zone).join(', ')}) — federal flood insurance may be required.`
      : `Flood zone present: ${parcel.floodZones.map((z) => `Zone ${z.zone} (${z.riskLevel} risk)`).join(', ')}.`;

  const wildfireSection = parcel.wildfireRisk == null
    ? 'Wildfire risk rating not available.'
    : `FEMA NRI wildfire risk: ${parcel.wildfireRisk}.`;

  const mineSection = parcel.mineSiteCount === 0
    ? 'No mine sites within 10 miles.'
    : `${parcel.mineSiteCount} USGS-recorded mine site${parcel.mineSiteCount > 1 ? 's' : ''} within 10 miles — environmental assessment recommended.`;

  const easementSection = parcel.conservationEasements.length === 0
    ? 'No conservation easements found in the NCED database.'
    : `${parcel.conservationEasements.length} conservation easement${parcel.conservationEasements.length > 1 ? 's' : ''} found` +
      (parcel.conservationEasements[0]?.holderName ? ` (held by ${parcel.conservationEasements.map((e) => e.holderName).filter(Boolean).join(', ')})` : '') +
      ' — development and subdivision rights may be restricted.';

  const prompt = `You are a land analyst specializing in rural Montana real estate. Write a concise buildability and due diligence summary for a land parcel based on the data below. Focus on what a buyer needs to know before making an offer — especially anything that could block construction, limit use, or require costly remediation. Be direct and factual. Flag missing information as unknown rather than speculating. Write 3–5 sentences in plain prose (no bullet points, no headers).

Parcel details:
- County: ${parcel.county ?? 'unknown'}
- Acreage: ${parcel.acreage != null ? parcel.acreage : 'unknown'}
- Address/location: ${parcel.address ?? 'not specified'}

Water rights:
${waterSection}

Road access:
${roadSection}

Electric service:
${electricSection}

Broadband:
${broadbandSection}

Flood risk:
${floodSection}

Wildfire risk:
${wildfireSection}

Mine sites:
${mineSection}

Conservation easements:
${easementSection}

Write the summary now:`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ text: string }>;
  };
  const text = parsed.content[0]?.text;
  if (!text) throw new Error('Bedrock returned empty content');
  return text;
}

export interface WebSearchResultItem {
  title: string;
  snippet: string;
  link: string;
}

export interface ListingStatusCheck {
  forSale: boolean;
  confidence: 'high' | 'medium' | 'low';
  price: number | null;
  listingUrl: string | null;
  source: string | null;
  summary: string;
}

// Classifies whether a property is for sale from already-fetched web search
// results — Bedrock never makes its own web requests here, it only reasons over
// the snippets it's given, so it can't fabricate a price/URL that isn't in them.
export async function checkListingStatusFromSearchResults(
  address: string,
  results: WebSearchResultItem[]
): Promise<ListingStatusCheck> {
  if (results.length === 0) {
    return {
      forSale: false,
      confidence: 'low',
      price: null,
      listingUrl: null,
      source: null,
      summary: 'No search results found for this address.',
    };
  }

  const resultsText = results
    .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\nURL: ${r.link}`)
    .join('\n\n');

  const prompt = `You are a real estate research assistant. Based ONLY on the search results below, determine whether this property is currently listed for sale: ${address}

Search results:
${resultsText}

Respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"forSale": boolean, "confidence": "high"|"medium"|"low", "price": number|null, "listingUrl": string|null, "source": string|null, "summary": string}

Rules:
- Only set forSale to true if a result clearly indicates an active listing (e.g. "for sale", a dollar amount, a listing site like Zillow, LandWatch, Realtor.com, Land.com, or a real estate brokerage).
- Never invent a price, URL, or source that isn't directly stated in the search results.
- If you cannot confirm it's for sale from these results, set forSale to false and confidence to "low".
- summary must be exactly one sentence describing what you found (or didn't find).`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(command);
  const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ text: string }>;
  };
  const text = parsed.content[0]?.text;
  if (!text) throw new Error('Bedrock returned empty content');

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Bedrock response did not contain a JSON object');

  const data = JSON.parse(jsonMatch[0]) as {
    forSale: unknown;
    confidence: unknown;
    price: unknown;
    listingUrl: unknown;
    source: unknown;
    summary: unknown;
  };

  return {
    forSale: Boolean(data.forSale),
    confidence: data.confidence === 'high' || data.confidence === 'medium' ? data.confidence : 'low',
    price: typeof data.price === 'number' ? data.price : null,
    listingUrl: typeof data.listingUrl === 'string' ? data.listingUrl : null,
    source: typeof data.source === 'string' ? data.source : null,
    summary: typeof data.summary === 'string' ? data.summary : '',
  };
}
