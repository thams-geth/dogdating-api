import { z } from 'zod';
import { countries, type AppPolicy } from './policy.js';

export const bootstrapQuery = z.object({
  platform: z.enum(['android', 'ios']),
  buildNumber: z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).refine(Number.isSafeInteger),
  countryCode: z.string().regex(/^[A-Z]{2}$/).default('IN'),
  locale: z.string().min(2).max(35).default('en-IN'),
}).strict();

export function bootstrap(input: z.infer<typeof bootstrapQuery>, policy: AppPolicy) {
  const country = countries.find((item) => item.countryCode === input.countryCode);
  const release = policy[input.platform];
  const update = input.buildNumber < release.minimumBuild ? 'required'
    : input.buildNumber < release.latestBuild ? 'recommended' : 'none';
  return {
    policyRevision: policy.revision,
    maintenance: policy.maintenance,
    country: country ?? { countryCode: input.countryCode, rollout: 'unavailable' },
    effectiveLocale: country?.supportedLocales.find((locale) => locale === input.locale) ?? 'en-IN',
    update: { action: update, ...release },
    // Do not advertise product routes which have not been delivered yet.
    features: { pack: false, lineage: false, spark: false, billing: false },
    legal: { termsVersion: null, privacyVersion: null, communityVersion: null },
  };
}
