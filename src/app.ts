import { waitlistRoutes } from './modules/app/waitlist.js';
import { StaffAuth,OidcStaffVerifier,type StaffVerifier } from './modules/admin/staff-auth.js';
import { AdminService } from './modules/admin/admin.service.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { SafetyService } from './modules/safety/safety.service.js';
import { PrivacyService } from './modules/safety/privacy.service.js';
import { safetyRoutes } from './modules/safety/safety.routes.js';
import { MeetupsService } from './modules/meetups/meetups.service.js';
import { meetupRoutes } from './modules/meetups/meetups.routes.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';
import { RealtimeService } from './modules/messages/realtime.js';
import { authenticate,currentUser } from './http/authenticate.js';
import { MessagesService } from './modules/messages/messages.service.js';
import { messageRoutes } from './modules/messages/messages.routes.js';
import { LocalMessageCipher,type MessageCipher } from './modules/messages/message-cipher.js';
import express from 'express';
import { ConnectionsService } from './modules/connections/connections.service.js';
import { connectionRoutes } from './modules/connections/connections.routes.js';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { pool } from './db/pool.js';
import { ApiError, errorHandler, notFound } from './middleware/error.js';
import { asyncHandler } from './http/async-handler.js';
import { appRoutes } from './modules/app/app.routes.js';
import { defaultPolicy, policySchema, type AppPolicy } from './modules/app/policy.js';
import { breedRoutes } from './modules/breeds/breeds.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { AuthService } from './modules/auth/auth.service.js';
import { DevelopmentOtpSender } from './modules/auth/otp-sender.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { legalRoutes,onboardingRoutes } from './modules/onboarding/onboarding.routes.js';
import { HouseholdsService } from './modules/households/households.service.js';
import { householdRoutes,invitationRoutes } from './modules/households/households.routes.js';
import { DogsService } from './modules/dogs/dogs.service.js';
import { dogRoutes } from './modules/dogs/dogs.routes.js';
import { config } from './config.js';
import { MediaService } from './modules/media/media.service.js';
import { mediaRoutes } from './modules/media/media.routes.js';
import { LocalPhotoStorage, type PhotoStorage } from './modules/media/media.storage.js';
import { VerificationService } from './modules/verification/verification.service.js';
import { verificationRoutes } from './modules/verification/verification.routes.js';
import { LocationService } from './modules/location/location.service.js';
import { areaRoutes, locationRoutes } from './modules/location/location.routes.js';
import { BlocksService } from './modules/safety/blocks.service.js';
import { blockRoutes } from './modules/safety/blocks.routes.js';
import { DiscoveryService } from './modules/discovery/discovery.service.js';
import { discoveryRoutes } from './modules/discovery/discovery.routes.js';

export function createApp(deps: { database?: Pool; policy?: AppPolicy; auth?: AuthService; photoStorage?: PhotoStorage; discoverySecret?: string; messageCipher?: MessageCipher; staffVerifier?:StaffVerifier } = {}) {
  const database = deps.database ?? pool;
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/v1/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/v1/ready', asyncHandler(async (_req, res) => {
    try {
      const result = await database.query('SELECT version FROM ops.schema_migrations WHERE version = $1', ['0026']);
      if (!result.rowCount) throw new Error('Schema not ready');
    } catch {
      throw new ApiError(503, 'not-ready', 'Database or required schema is unavailable.');
    }
    res.json({ status: 'ready' });
  }));
  app.use('/v1/app', appRoutes(policySchema.parse(deps.policy ?? defaultPolicy)));
  const location = new LocationService(database);
  app.use('/v1/app/areas', areaRoutes(location));
  app.use('/v1/dogs/breeds', breedRoutes(database));
  const auth = deps.auth ?? (config.OTP_MODE === 'development' && config.AUTH_SECRET
    ? new AuthService(database, config.AUTH_SECRET, new DevelopmentOtpSender(config.NODE_ENV)) : undefined);
  const messageCipher=deps.messageCipher ?? (config.MESSAGE_KEY?new LocalMessageCipher(config.MESSAGE_KEY,config.NODE_ENV):undefined);
  app.use('/v1',safetyRoutes(new SafetyService(database,messageCipher),new PrivacyService(database),auth));
  app.use('/v1/waitlist',waitlistRoutes(database,auth));
  app.use('/v1', authRoutes(auth));
  const onboarding=new OnboardingService(database);
  app.use('/v1/legal',legalRoutes(onboarding));
  app.use('/v1/me',onboardingRoutes(onboarding,auth));
  app.use('/v1/me/blocks',blockRoutes(new BlocksService(database),auth));
  const households=new HouseholdsService(database,(phone)=> {
    if(!auth)throw new ApiError(503,'auth-unavailable','Authentication is not configured.');
    return auth.phoneIndex(phone);
  });
  app.use('/v1/households',householdRoutes(households,auth));
  app.use('/v1/households',locationRoutes(location,auth));
  app.use('/v1/household-invitations',invitationRoutes(households,auth));
  app.use('/v1/dogs',dogRoutes(new DogsService(database),auth));
  const photos = deps.photoStorage ?? (config.MEDIA_MODE === 'local' ? new LocalPhotoStorage(config.MEDIA_LOCAL_DIR, config.NODE_ENV) : undefined);
  app.use('/v1', mediaRoutes(new MediaService(database, photos), auth));
  app.use('/v1', verificationRoutes(new VerificationService(database), auth));
  app.use('/v1',discoveryRoutes(new DiscoveryService(database,deps.discoverySecret ?? (config.DISCOVERY_MODE==='development'?config.AUTH_SECRET:undefined),!!messageCipher),auth));
  app.use('/v1',connectionRoutes(new ConnectionsService(database,deps.discoverySecret ?? (config.DISCOVERY_MODE==='development'?config.AUTH_SECRET:undefined)),auth));
  const messages=new MessagesService(database,messageCipher);
  app.use('/v1',messageRoutes(messages,auth));
  const realtime=new RealtimeService(database,messages);
  if(messageCipher)app.locals.realtime=realtime;
  app.post('/v1/realtime/tickets',authenticate(auth),asyncHandler(async(_req,res)=>{
    if(!messageCipher)throw new ApiError(503,'messaging-unavailable','Message encryption is not configured.');
    res.status(201).json(await realtime.ticket(currentUser(res)));
  }));
  app.use('/v1',notificationRoutes(new NotificationsService(database,messageCipher),auth));
  app.use('/v1',meetupRoutes(new MeetupsService(database,messageCipher),auth));
  const staffVerifier=deps.staffVerifier ?? (config.STAFF_ISSUER&&config.STAFF_JWKS_URL&&config.STAFF_AUDIENCE?new OidcStaffVerifier(config.STAFF_ISSUER,config.STAFF_JWKS_URL,config.STAFF_AUDIENCE):undefined);
  app.use('/admin/v1',adminRoutes(new AdminService(database,messageCipher),new StaffAuth(database,staffVerifier)));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
