import { z } from 'zod';
export const uploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png']),
  sizeBytes: z.number().int().min(1).max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const orderSchema = z.object({ mediaIds: z.array(z.string().uuid()).min(1).max(30)
  .refine(ids => new Set(ids).size === ids.length) }).strict();
