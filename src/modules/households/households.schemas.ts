import { z } from 'zod';
export const householdSchema=z.object({name:z.string().trim().min(1).max(80)}).strict();
export const roleSchema=z.object({role:z.enum(['owner','co_guardian','walker','view_only'])}).strict();
export const inviteSchema=z.object({phoneE164:z.string().regex(/^\+91[6-9]\d{9}$/),role:z.enum(['co_guardian','walker','view_only']).default('co_guardian')}).strict();
export const inviteTokenSchema=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
