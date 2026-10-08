import { z } from 'zod';
import { pageQuery } from '../../http/pagination.js';
export const actorQuery=z.object({dogId:z.string().uuid().optional()}).strict();
export const feedQuery=pageQuery.extend({dogId:z.string().uuid().optional(),mode:z.literal('pack').default('pack'),cursor:z.string().max(2048).optional()});
export const profileQuery=z.object({dogId:z.string().uuid(),impressionToken:z.string().min(1).max(2048)}).strict();
