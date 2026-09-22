import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { WebSearchResultItem } from './bedrock';
import { env } from './env';
import { fetchJson } from './http';

const SERPER_URL = 'https://google.serper.dev/search';
const SEARCH_TIMEOUT_MS = 10_000;

const secretsClient = new SecretsManagerClient({});
let apiKey: string | null = null;

async function getApiKey(): Promise<string> {
  if (apiKey) return apiKey;
  const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: env.serperSecretArn }));
  if (!response.SecretString) throw new Error('Serper secret has no value');
  apiKey = (JSON.parse(response.SecretString) as { apiKey: string }).apiKey;
  return apiKey;
}

interface SerperResponse {
  organic?: Array<{ title?: string; snippet?: string; link?: string }>;
}

/** Returns Google web results for `query` through Serper.dev. */
export async function searchWeb(query: string, num = 5): Promise<WebSearchResultItem[]> {
  const data = await fetchJson<SerperResponse>(
    SERPER_URL,
    {
      method: 'POST',
      headers: { 'X-API-KEY': await getApiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num }),
    },
    SEARCH_TIMEOUT_MS
  );
  return (data.organic ?? []).slice(0, num).map((item) => ({
    title: item.title ?? '',
    snippet: item.snippet ?? '',
    link: item.link ?? '',
  }));
}
