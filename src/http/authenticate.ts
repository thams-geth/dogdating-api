import type { Response } from 'express';
import type { AuthService, Principal } from '../modules/auth/auth.service.js';
import { ApiError } from '../middleware/error.js';
import { asyncHandler } from './async-handler.js';

export function authenticate(service?: AuthService) {
  return asyncHandler(async (req, res, next) => {
    if (!service) throw new ApiError(503, 'auth-unavailable', 'Authentication is not configured.');
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ') || header.length > 4096) throw new ApiError(401, 'unauthenticated', 'A bearer token is required.');
    res.locals.principal = await service.authenticate(header.slice(7));
    next();
  });
}
export function currentUser(res: Response): Principal { return res.locals.principal as Principal; }
