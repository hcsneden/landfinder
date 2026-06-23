import type { APIGatewayProxyEvent } from 'aws-lambda';

export function getUserIdFromEvent(event: APIGatewayProxyEvent): string | null {
  const claims = event.requestContext.authorizer?.claims;
  return claims?.sub ?? null;
}
