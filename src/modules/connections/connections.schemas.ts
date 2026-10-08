import { z } from 'zod';
import { pageQuery } from '../../http/pagination.js';
export const decisionSchema=z.object({actorDogId:z.string().uuid(),targetDogId:z.string().uuid(),mode:z.literal('pack'),verdict:z.enum(['interest','pass']),impressionToken:z.string().max(2048)}).strict();
export const connectionQuery=pageQuery.extend({dogId:z.string().uuid()});
