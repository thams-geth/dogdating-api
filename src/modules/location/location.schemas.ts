import { z } from 'zod';
import { pageQuery } from '../../http/pagination.js';
export const areaQuery = pageQuery.extend({
  countryCode: z.string().regex(/^[A-Z]{2}$/).default('IN'),
  query: z.string().trim().max(80).default(''),
});
export const locationSchema = z.object({ source: z.literal('manual_area'), areaId: z.string().uuid() }).strict();
