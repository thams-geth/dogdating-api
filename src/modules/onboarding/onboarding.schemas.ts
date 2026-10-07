import { z } from 'zod';
export const purposeSchema = z.enum(['terms','privacy','community','location','marketing']);
export const legalQuery = z.object({
  countryCode: z.literal('IN').default('IN'), locale: z.literal('en-IN').default('en-IN'),
  version: z.string().min(1).max(60).optional(),
}).strict();
export const consentSchema = z.object({ documentId: z.string().uuid() }).strict();
export const onboardingPreferencesSchema = z.object({
  countryCode: z.literal('IN'), locale: z.literal('en-IN'), mode: z.literal('pack'), adultDeclared: z.boolean(),
}).strict();
export const activeDogSchema = z.object({ dogId: z.string().uuid().nullable() }).strict();
export const preferencesSchema = z.object({ discoveryPaused: z.boolean().optional(), readReceipts: z.boolean().optional() })
  .strict().refine((value) => Object.keys(value).length > 0);
export const emptyBody = z.object({}).strict();
