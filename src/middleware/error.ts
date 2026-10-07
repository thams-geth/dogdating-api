import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export const notFound: RequestHandler = (_req, _res, next) => next(new ApiError(404, 'not-found', 'Route not found.'));

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) return next(error);
  const parserType = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
  const problem = error instanceof ApiError ? error
    : error instanceof ZodError ? new ApiError(400, 'validation-failed', 'Request validation failed.')
    : parserType === 'entity.parse.failed' ? new ApiError(400, 'invalid-json', 'Request body must be valid JSON.')
    : parserType === 'entity.too.large' ? new ApiError(413, 'payload-too-large', 'Request body exceeds the size limit.')
    : new ApiError(500, 'internal-error', 'An unexpected error occurred.');
  if (problem.status >= 500) {
    // Error values can contain connection strings, SQL or user input. Log an opaque correlation ID.
    console.error(JSON.stringify({ event: 'request.failed', code: problem.code, requestId: res.locals.requestId }));
  }
  res.status(problem.status).type('application/problem+json').json({
    type: `urn:waggle:problem:${problem.code}`, code: problem.code,
    title: problem.code, status: problem.status, detail: problem.message,
    requestId: res.locals.requestId,
    ...(error instanceof ZodError ? { errors: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code })) } : {}),
  });
};
