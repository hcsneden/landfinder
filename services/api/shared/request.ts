import type { APIGatewayProxyEvent } from 'aws-lambda';

/** Returns the parsed JSON body, or null when the body is missing or malformed. */
export function parseJsonBody<T>(event: APIGatewayProxyEvent): T | null {
  if (!event.body) return null;
  try {
    return JSON.parse(event.body) as T;
  } catch {
    return null;
  }
}

export function getUserId(event: APIGatewayProxyEvent): string | null {
  return event.requestContext.authorizer?.claims?.sub ?? null;
}

export function getPathParameter(event: APIGatewayProxyEvent, name: string): string | null {
  return event.pathParameters?.[name] ?? null;
}

/** Parses a positive integer query parameter, falling back to `fallback`. */
export function getPositiveIntParameter(event: APIGatewayProxyEvent, name: string, fallback: number): number {
  const parsed = Number.parseInt(event.queryStringParameters?.[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
