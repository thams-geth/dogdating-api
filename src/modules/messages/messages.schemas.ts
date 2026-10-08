import { z } from 'zod';
const seq=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(s=>BigInt(s)<=9223372036854775807n);
export const messageInput=z.object({clientMessageId:z.string().uuid(),kind:z.literal('text'),body:z.string().trim().min(1).max(4000)}).strict();
export const historyQuery=z.object({beforeSeq:seq.optional(),afterSeq:z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(s=>BigInt(s)<=9223372036854775807n).optional(),limit:z.string().regex(/^[1-9][0-9]?$/).transform(Number).refine(n=>n<=50).default('30')}).strict().refine(q=>!(q.beforeSeq&&q.afterSeq),{message:'Use beforeSeq or afterSeq, not both.'});
export const readInput=z.object({upToSeq:seq}).strict();
export const conversationPreferences=z.object({archived:z.boolean().optional(),mutedUntil:z.string().datetime({offset:true}).nullable().optional()}).strict().refine(v=>Object.keys(v).length>0);
