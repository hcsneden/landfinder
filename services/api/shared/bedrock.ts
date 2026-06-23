import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { tracer } from './tracer';

const client = tracer.captureAWSv3Client(new BedrockRuntimeClient({}));

export const BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID ??
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0';

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

  const prompt = `You are a land analyst specializing in rural Montana real estate. Write a concise buildability and due diligence summary for a land parcel based on the data below. Focus on what a buyer needs to know before making an offer. Be direct and factual — flag missing information as unknown rather than speculating. Write 3–5 sentences in plain prose (no bullet points, no headers).

Parcel details:
- County: ${parcel.county ?? 'unknown'}
- Acreage: ${parcel.acreage != null ? parcel.acreage : 'unknown'}
- Address/location: ${parcel.address ?? 'not specified'}

Water rights:
${waterSection}

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
  return parsed.content[0].text;
}
