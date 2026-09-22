import type { APIGatewayProxyResult } from 'aws-lambda';
import type { ApiResponse } from '@lastbestland/shared';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function jsonResponse<T>(statusCode: number, body: ApiResponse<T>): APIGatewayProxyResult {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export function success<T>(data: T): APIGatewayProxyResult {
  return jsonResponse(200, { success: true, data });
}

export function created<T>(data: T): APIGatewayProxyResult {
  return jsonResponse(201, { success: true, data });
}

export function error(statusCode: number, code: string, message: string): APIGatewayProxyResult {
  return jsonResponse(statusCode, { success: false, error: { code, message } });
}

export const badRequest = (message: string) => error(400, 'BAD_REQUEST', message);
export const unauthorized = (message = 'Unauthorized') => error(401, 'UNAUTHORIZED', message);
export const notFound = (message = 'Not found') => error(404, 'NOT_FOUND', message);
export const methodNotAllowed = () => error(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
export const serviceUnavailable = (message: string) => error(503, 'SERVICE_UNAVAILABLE', message);
export const serverError = (message = 'Internal server error') => error(500, 'SERVER_ERROR', message);
