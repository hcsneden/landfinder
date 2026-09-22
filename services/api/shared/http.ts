/** Fetches a URL and decodes the JSON body, failing after `timeoutMs`. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} from ${new URL(url).host} ${body.slice(0, 200)}`.trim());
  }
  return (await response.json()) as T;
}

export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError';
}
