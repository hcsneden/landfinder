const USER_AGENT = 'LastBestLand/1.0 (property research tool)';

export async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return response;
}

export async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  return (await (await fetchWithTimeout(url, timeoutMs)).json()) as T;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
