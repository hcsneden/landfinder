import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type { WebSearchResultItem } from './bedrock';

const secretsClient = new SecretsManagerClient({});

interface SerperCredentials {
  apiKey: string;
}

let credentials: SerperCredentials | null = null;

async function getCredentials(): Promise<SerperCredentials> {
  if (credentials) return credentials;

  const secretArn = process.env.SERPER_SECRET_ARN;
  if (!secretArn) {
    throw new Error('SERPER_SECRET_ARN environment variable not set');
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  if (!response.SecretString) {
    throw new Error('Failed to retrieve Serper credentials');
  }

  credentials = JSON.parse(response.SecretString) as SerperCredentials;
  return credentials;
}

const SERPER_URL = 'https://google.serper.dev/search';
const SEARCH_TIMEOUT_MS = 10_000;

interface SerperResponse {
  organic?: Array<{ title?: string; snippet?: string; link?: string }>;
}

// Fetches Google search results via Serper.dev. Google's own Custom Search JSON
// API was closed to new customers, so Serper provides equivalent Google SERP
// results (title/snippet/link) that we hand to Bedrock for listing classification.
export async function searchWeb(
  query: string,
  num = 5
): Promise<WebSearchResultItem[]> {
  const { apiKey } = await getCredentials();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Serper search HTTP ${res.status}`);

    const data = await res.json() as SerperResponse;
    return (data.organic ?? []).slice(0, num).map((item) => ({
      title: item.title ?? '',
      snippet: item.snippet ?? '',
      link: item.link ?? '',
    }));
  } finally {
    clearTimeout(timer);
  }
}
