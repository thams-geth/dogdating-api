import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => next(new ApiError(404, 'not-found', 'Route not found'));

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const status = error instanceof ApiError ? error.status : error instanceof ZodError ? 400 : 500;
  const code = error instanceof ApiError ? error.code : error instanceof ZodError ? 'validation-failed' : 'internal-error';
  const detail = status === 500 ? 'An unexpected error occurred' : error instanceof Error ? error.message : 'Invalid request';
  if (status === 500) console.error(error);
  res.status(status).type('application/problem+json').json({
    type: `https://api.waggle.app/problems/${code}`,
    title: code,
    status,
    detail,
  });
};
