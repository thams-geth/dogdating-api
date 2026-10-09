import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { ApiError } from '../../middleware/error.js';
import { transaction } from '../../db/transaction.js';
import { AuthRepository, lockScope, type SessionRow, type UserRow } from './auth.repository.js';
import { uuidSchema, type verifyOtpSchema, type profileSchema } from './auth.schemas.js';
import type { OtpSender } from './otp-sender.js';

export interface Principal { userId: string; sessionId: string; familyId: string }
export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number; userId: string }
type Result<T> = { value: T } | { error: ApiError };
const invalidOtp = () => new ApiError(401, 'invalid-otp', 'That code is invalid or expired.');
const invalidSession = () => new ApiError(401, 'invalid-session', 'Sign in again to continue.');
const usable = (status: string) => status === 'pending' || status === 'active';

export class AuthService {
  private readonly repo: AuthRepository;
  private readonly signingKey: Uint8Array;
  constructor(private readonly database: Pool, private readonly secret: string, private readonly sender: OtpSender) {
    if (secret.length < 64) throw new Error('Authentication secret must contain at least 64 characters');
    this.repo = new AuthRepository(database);
    this.signingKey = createHmac('sha256', secret).update('access-signing').digest();
  }
  private hash(purpose: string, value: string): string {
    return createHmac('sha256', this.secret).update(`${purpose}:${value}`).digest('hex');
  }
  phoneIndex(phone: string): string { return this.hash('phone', phone); }
  private equal(left: string, right: string): boolean {
    const a = Buffer.from(left); const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  private unwrap<T>(result: Result<T>): T {
    // Called AFTER COMMIT, so rejected attempts and revocations are durable.
    if ('error' in result) throw result.error;
    return result.value;
  }

  async requestOtp(phone: string, countryCode: string): Promise<void> {
    const index = this.hash('phone', phone);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = await transaction(this.database, async (tx) => {
      await lockScope(tx, `phone:${index}`);
      const recent = await tx.query<{ count: number; too_soon: boolean }>(`SELECT count(*)::int AS count,
        coalesce(max(created_at) > now() - interval '60 seconds', false) AS too_soon
        FROM identity.otp_challenges WHERE phone_blind_index=$1 AND created_at > now() - interval '1 hour'`, [index]);
      if (recent.rows[0]!.count >= 3 || recent.rows[0]!.too_soon) return null;
      await tx.query('UPDATE identity.otp_challenges SET consumed_at=now() WHERE phone_blind_index=$1 AND consumed_at IS NULL', [index]);
      const challengeId = randomUUID();
      await tx.query(`INSERT INTO identity.otp_challenges (id, phone_blind_index, code_hash, country_code, expires_at)
        VALUES ($1,$2,$3,$4,now()+interval '10 minutes')`, [challengeId, index, this.hash('otp', `${index}:${code}`), countryCode]);
      return challengeId;
    });
    if (id === null) return;
    try {
      await this.sender.send(phone, code);
      await this.database.query('UPDATE identity.otp_challenges SET delivered_at=now() WHERE id=$1', [id]);
    } catch {
      await this.database.query('UPDATE identity.otp_challenges SET consumed_at=now() WHERE id=$1', [id]);
      console.error(JSON.stringify({ event: 'otp.delivery_failed' }));
      // Same public result for provider failures. No exception payload contains the destination/code.
    }
  }

  async verifyOtp(input: z.infer<typeof verifyOtpSchema>): Promise<TokenPair> {
    const index = this.hash('phone', input.phoneE164);
    const result = await transaction<Result<TokenPair>>(this.database, async (tx) => {
      await lockScope(tx, `phone:${index}`);
      const challenge = await this.repo.latestChallenge(tx, index);
      if (!challenge || !challenge.delivered_at || challenge.expires_at <= new Date() || challenge.attempt_count >= challenge.max_attempts) {
        return { error: invalidOtp() };
      }
      if (!this.equal(this.hash('otp', `${index}:${input.code}`), challenge.code_hash)) {
        await tx.query(`UPDATE identity.otp_challenges SET attempt_count=attempt_count+1,
          consumed_at=CASE WHEN attempt_count+1 >= max_attempts THEN now() ELSE NULL END WHERE id=$1`, [challenge.id]);
        return { error: invalidOtp() };
      }
      let user = await this.repo.userByPhone(tx, index);
      if (!user && !input.displayName) return { error: new ApiError(400, 'display-name-required', 'A display name is required for a new account.') };
      await tx.query('UPDATE identity.otp_challenges SET consumed_at=now() WHERE id=$1', [challenge.id]);
      if (!user) {
        user = (await tx.query<UserRow>(`INSERT INTO identity.users
          (id,phone_e164,phone_blind_index,phone_verified_at,display_name,country_code,status)
          VALUES ($1,$2,$3,now(),$4,$5,'pending') RETURNING *`,
        [randomUUID(), input.phoneE164, index, input.displayName, challenge.country_code])).rows[0]!;
      }
      if (!usable(user.status)) return { error: invalidSession() };
      return { value: await this.issue(tx, user.id, input.deviceId, randomUUID(), new Date(Date.now() + 30 * 86400_000)) };
    });
    return this.unwrap(result);
  }

  private async issue(tx: PoolClient, userId: string, deviceId: string, familyId: string, expiresAt: Date): Promise<TokenPair> {
    const id = randomUUID(); const refreshSecret = randomBytes(32).toString('base64url');
    await tx.query(`INSERT INTO identity.sessions (id,user_id,device_id,family_id,refresh_hash,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6)`, [id,userId,deviceId,familyId,`hmac-sha256:${this.hash('refresh', refreshSecret)}`,expiresAt]);
    const accessToken = await new SignJWT({ sid: id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(userId).setIssuer('waggle-api').setAudience('waggle-mobile').setIssuedAt().setExpirationTime('15m').sign(this.signingKey);
    return { accessToken, refreshToken: `${id}.${refreshSecret}`, expiresIn: 900, userId };
  }

  async refresh(token: string): Promise<TokenPair> {
    const [sessionId, secret] = token.split('.');
    if (!uuidSchema.safeParse(sessionId).success || !secret) throw invalidSession();
    const result = await transaction<Result<TokenPair>>(this.database, async (tx) => {
      const initial = await this.repo.session(tx, sessionId!);
      if (!initial) return { error: invalidSession() };
      await lockScope(tx, `family:${initial.family_id}`);
      const session = (await this.repo.session(tx, initial.id))!;
      if (!this.equal(session.refresh_hash, `hmac-sha256:${this.hash('refresh', secret)}`)) return { error: invalidSession() };
      if (session.rotated_at) {
        await this.revokeFamily(tx, session.family_id, 'refresh_reuse');
        return { error: invalidSession() };
      }
      if (session.revoked_at || session.expires_at <= new Date()) return { error: invalidSession() };
      // Serialize account-wide logout with issuance; all paths lock family before user.
      const user = (await tx.query<UserRow>('SELECT * FROM identity.users WHERE id=$1 FOR UPDATE', [session.user_id])).rows[0];
      if (!user || !usable(user.status)) return { error: invalidSession() };
      // An account-wide logout may have committed while we waited for the user lock.
      const current = (await this.repo.session(tx, session.id))!;
      if (current.revoked_at) return { error: invalidSession() };
      const pair = await this.issue(tx, user.id, session.device_id, session.family_id, session.expires_at);
      await tx.query('UPDATE identity.sessions SET rotated_at=now(), replaced_by=$2 WHERE id=$1', [session.id, pair.refreshToken.split('.')[0]]);
      return { value: pair };
    });
    return this.unwrap(result);
  }

  async authenticate(token: string): Promise<Principal> {
    let userId: string; let sessionId: string;
    try {
      const { payload } = await jwtVerify(token, this.signingKey, { algorithms: ['HS256'], issuer: 'waggle-api', audience: 'waggle-mobile', requiredClaims: ['exp', 'iat', 'sub', 'sid'] });
      userId = uuidSchema.parse(payload.sub); sessionId = uuidSchema.parse(payload.sid);
    } catch { throw invalidSession(); }
    const result = await this.database.query<SessionRow & { status: string }>(`SELECT s.*,u.status FROM identity.sessions s
      JOIN identity.users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()`, [sessionId,userId]);
    const session = result.rows[0];
    if (!session || !usable(session.status)) throw invalidSession();
    return { userId, sessionId, familyId: session.family_id };
  }
  private async revokeFamily(tx: PoolClient, familyId: string, reason: string): Promise<void> {
    await tx.query(`UPDATE identity.sessions SET revoked_at=coalesce(revoked_at,now()), revoked_reason=$2
      WHERE family_id=$1`, [familyId, reason]);
    await tx.query('DELETE FROM identity.devices WHERE family_id=$1',[familyId]);
  }
  async logout(principal: Principal): Promise<void> {
    await transaction(this.database, async (tx) => {
      await lockScope(tx, `family:${principal.familyId}`);
      await this.revokeFamily(tx, principal.familyId, 'logout');
    });
  }
  async logoutAll(principal: Principal): Promise<void> {
    await transaction(this.database, async (tx) => {
      await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE', [principal.userId]);
      await tx.query(`UPDATE identity.sessions SET revoked_at=coalesce(revoked_at,now()), revoked_reason='logout_all' WHERE user_id=$1`, [principal.userId]);
      await tx.query('DELETE FROM identity.devices WHERE user_id=$1',[principal.userId]);
    });
  }
  async sessions(principal: Principal) {
    const result = await this.database.query(`SELECT id, device_id AS "deviceId", created_at AS "createdAt", expires_at AS "expiresAt"
      FROM identity.sessions WHERE user_id=$1 AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at>now()
      ORDER BY created_at DESC LIMIT 100`, [principal.userId]);
    return { sessions: result.rows.map((row) => ({ ...row, current: row.id === principal.sessionId })) };
  }
  async revokeSession(principal: Principal, id: string): Promise<void> {
    await transaction(this.database, async (tx) => {
      const session = await this.repo.session(tx, id);
      if (!session || session.user_id !== principal.userId) throw new ApiError(404, 'not-found', 'Session not found.');
      await lockScope(tx, `family:${session.family_id}`);
      await this.revokeFamily(tx, session.family_id, 'device_revoked');
    });
  }
  async me(principal: Principal) {
    const user = (await this.database.query<UserRow>('SELECT * FROM identity.users WHERE id=$1', [principal.userId])).rows[0];
    if (!user) throw invalidSession();
    return {
      id: user.id, displayName: user.display_name, phoneE164Masked: `******${user.phone_e164.slice(-4)}`,
      locale: user.locale, timezone: user.timezone, status: user.status, countryCode: user.country_code,
      residencyRegion: user.residency_region, createdAt: user.created_at,
    };
  }
  async updateMe(principal: Principal, input: z.infer<typeof profileSchema>) {
    await this.database.query(`UPDATE identity.users SET display_name=coalesce($2,display_name),
      locale=coalesce($3,locale),timezone=coalesce($4,timezone),updated_at=now() WHERE id=$1`,
    [principal.userId, input.displayName, input.locale, input.timezone]);
    return this.me(principal);
  }
}
