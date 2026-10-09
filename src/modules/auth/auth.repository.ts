import type { Pool, PoolClient } from 'pg';

export interface UserRow {
  deletion_requested_at?:Date|null; deleted_at?:Date|null; id: string; phone_e164: string; display_name: string; locale: string;
  timezone: string; status: string; country_code: string; residency_region: string; created_at: Date;
}
export interface SessionRow {
  id: string; user_id: string; family_id: string; device_id: string;
  refresh_hash: string; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null;
}
export interface ChallengeRow {
  requested_by?:string|null; id: string; code_hash: string; attempt_count: number; max_attempts: number;
  country_code: string; expires_at: Date; delivered_at: Date | null;
}

export async function lockScope(tx: PoolClient, scope: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
}

export class AuthRepository {
  constructor(readonly database: Pool) {}
  async userByPhone(tx: PoolClient, index: string): Promise<UserRow | undefined> {
    return (await tx.query<UserRow>('SELECT * FROM identity.users WHERE phone_blind_index=$1 FOR UPDATE', [index])).rows[0];
  }
  async latestChallenge(tx: PoolClient, index: string, purpose='auth'): Promise<ChallengeRow | undefined> {
    return (await tx.query<ChallengeRow>(`SELECT * FROM identity.otp_challenges
      WHERE phone_blind_index=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`, [index,purpose])).rows[0];
  }
  async session(tx: PoolClient, id: string): Promise<SessionRow | undefined> {
    return (await tx.query<SessionRow>('SELECT * FROM identity.sessions WHERE id=$1', [id])).rows[0];
  }
}
