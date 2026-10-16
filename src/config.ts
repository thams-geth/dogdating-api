import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url().default('postgres://waggle:waggle@localhost:5433/waggle'),
  OTP_MODE: z.enum(['disabled', 'development']).default('disabled'),
  MEDIA_MODE: z.enum(['disabled', 'local']).default('disabled'),
  MEDIA_LOCAL_DIR: z.string().min(1).default('.local/media'),
  DISCOVERY_MODE: z.enum(['disabled','development']).default('disabled'),
  FCM_PROJECT_ID: z.preprocess(v=>v===''?undefined:v,z.string().regex(/^[a-z][a-z0-9-]{5,99}$/).optional()),
  STAFF_ISSUER:z.string().url().startsWith('https://').optional(),
  STAFF_JWKS_URL:z.string().url().startsWith('https://').optional(),
  STAFF_AUDIENCE:z.string().min(1).optional(),
  MESSAGE_KEY: z.preprocess(v=>v===''?undefined:v,z.string().regex(/^[a-f0-9]{64}$/).optional()),
  AUTH_SECRET: z.preprocess((value) => value === '' ? undefined : value, z.string().min(64).optional()),
}).superRefine((value, context) => {
  if([value.STAFF_ISSUER,value.STAFF_JWKS_URL,value.STAFF_AUDIENCE].filter(Boolean).length%3!==0)context.addIssue({code:'custom',message:'Configure all staff OIDC settings together.'});
  if(value.MESSAGE_KEY&&value.NODE_ENV==='production')context.addIssue({code:'custom',message:'Local message encryption is forbidden in production.'});
  if (value.DISCOVERY_MODE==='development' && (value.NODE_ENV==='production' || !value.AUTH_SECRET)) {
    context.addIssue({code:'custom',message:'Development discovery needs AUTH_SECRET and cannot run in production.'});
  }
  if (value.MEDIA_MODE === 'local' && value.NODE_ENV === 'production') {
    context.addIssue({ code: 'custom', message: 'Local media storage cannot run in production.' });
  }
  if (value.OTP_MODE === 'development' && (value.NODE_ENV !== 'development' || !value.AUTH_SECRET)) {
    context.addIssue({ code: 'custom', message: 'Development OTP requires NODE_ENV=development and AUTH_SECRET (64+ characters).' });
  }
});

export const config = schema.parse(process.env);
