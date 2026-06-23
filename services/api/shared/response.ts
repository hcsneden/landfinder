import type { APIGatewayProxyResult } from 'aws-lambda';

export function success<T>(data: T): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify({
      success: true,
      data,
    }),
  };
}

export function created<T>(data: T): APIGatewayProxyResult {
  return {
    statusCode: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify({
      success: true,
      data,
    }),
  };
}

export function error(
  statusCode: number,
  code: string,
  message: string
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify({
      success: false,
      error: {
        code,
        message,
      },
    }),
  };
}

export function badRequest(message: string): APIGatewayProxyResult {
  return error(400, 'BAD_REQUEST', message);
}

export function unauthorized(message = 'Unauthorized'): APIGatewayProxyResult {
  return error(401, 'UNAUTHORIZED', message);
}

export function notFound(message = 'Not found'): APIGatewayProxyResult {
  return error(404, 'NOT_FOUND', message);
}

export function serverError(message = 'Internal server error'): APIGatewayProxyResult {
  return error(500, 'SERVER_ERROR', message);
}
