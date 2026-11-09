import type { RequestHandler } from 'express';

/**
 * Express 4 does not forward rejected promises to the error middleware.
 * Wrapping async handlers keeps database failures from leaving requests hanging.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}