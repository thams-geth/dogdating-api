import { z } from 'zod';

const releaseSchema = z.object({
  minimumBuild: z.number().int().positive(),
  latestBuild: z.number().int().positive(),
  storeUrl: z.string().url().startsWith('https://').nullable(),
}).strict().refine((release) => release.latestBuild >= release.minimumBuild, 'Latest build must be at least minimum build')
  .refine((release) => release.minimumBuild === 1 || release.storeUrl !== null, 'A forced update needs a published store URL');

export const policySchema = z.object({
  revision: z.string().min(1),
  maintenance: z.boolean(),
  android: releaseSchema,
  ios: releaseSchema,
}).strict();
export type AppPolicy = z.infer<typeof policySchema>;

// Reviewed configuration deployed with the service until staff release controls exist.
export const defaultPolicy: AppPolicy = policySchema.parse({
  revision: '2026-10-07.1', maintenance: false,
  android: { minimumBuild: 1, latestBuild: 1, storeUrl: null },
  ios: { minimumBuild: 1, latestBuild: 1, storeUrl: null },
});

export const countries = [{
  countryCode: 'IN', name: 'India', rollout: 'development',
  callingCode: '+91', currency: 'INR', distanceUnit: 'km',
  defaultLocale: 'en-IN', supportedLocales: ['en-IN'],
  defaultTimezone: 'Asia/Kolkata', minimumAge: 18,
}] as const;
