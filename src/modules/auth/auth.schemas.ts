import { z } from 'zod';

const phone = z.string().regex(/^\+[1-9]\d{6,14}$/)
  .refine((value) => !value.startsWith('+91') || /^\+91[6-9]\d{9}$/.test(value));
export const requestOtpSchema = z.object({
  phoneE164: phone.refine((value) => value.startsWith('+91'), 'Only India phone delivery is enabled at launch'),
  countryCode: z.literal('IN').default('IN'),
}).strict();
export const verifyOtpSchema = z.object({
  phoneE164: phone, code: z.string().regex(/^\d{6}$/), deviceId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(50).optional(),
}).strict();
export const refreshSchema = z.object({ refreshToken: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/).max(80) }).strict();
export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  locale: z.enum(['en-IN']).optional(),
  timezone: z.string().max(64).refine((value) => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
  }).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);
export const uuidSchema = z.string().uuid();
