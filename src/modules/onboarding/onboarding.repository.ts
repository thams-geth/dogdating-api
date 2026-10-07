import type { Pool, PoolClient } from 'pg';
import { householdRole } from '../households/access.js';
import { ApiError } from '../../middleware/error.js';
export type Queryable = Pool | PoolClient;
export const purposes = ['terms','privacy','community','location','marketing'] as const;
export const requiredPurposes = ['terms','privacy','community'] as const;
export interface PolicyRow {
  id: string; purpose: typeof purposes[number]; version: string; country_code: string; locale: string;
  body: string; content_sha256: string; published_at: Date;
}
export class OnboardingRepository {
  async lockUser(tx: PoolClient, userId: string) {
    const user = (await tx.query<{ country_code: string; locale: string; display_name: string }>(
      'SELECT country_code,locale,display_name FROM identity.users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!user) throw new ApiError(404,'not-found','Account not found.');
    await tx.query('INSERT INTO identity.user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    return user;
  }
  async documents(db: Queryable, country: string, locale: string): Promise<PolicyRow[]> {
    return (await db.query<PolicyRow>(`SELECT DISTINCT ON (purpose) * FROM identity.policy_documents
      WHERE country_code=$1 AND locale=$2 AND published_at<=now()
      ORDER BY purpose,published_at DESC,id DESC`, [country,locale])).rows;
  }
  async consents(db: Queryable, userId: string) {
    return (await db.query<{ purpose: string; document_id: string; action: string; recorded_at: Date }>(`
      SELECT DISTINCT ON (d.purpose) d.purpose,e.document_id,e.action,e.recorded_at
      FROM identity.consent_events e JOIN identity.policy_documents d ON d.id=e.document_id
      WHERE e.user_id=$1 ORDER BY d.purpose,e.id DESC`, [userId])).rows;
  }
  async snapshot(tx: PoolClient, userId: string) {
    const user = await this.lockUser(tx,userId);
    const preference = (await tx.query(`SELECT adult_declared,active_dog_id,onboarding_completed_at,
      discovery_paused,read_receipts FROM identity.user_preferences WHERE user_id=$1`, [userId])).rows[0]!;
    const documents = await this.documents(tx,user.country_code,user.locale);
    const consents = await this.consents(tx,userId);
    const selected=(await tx.query<{household_id:string}>('SELECT household_id FROM graph.dogs WHERE id=$1',[preference.active_dog_id])).rows[0];
    if (selected) await householdRole(tx,selected.household_id,userId);
    // Scope the selected dog every time: stale pointers never preserve revoked membership.
    const dog = (await tx.query(`SELECT d.id,d.household_id,d.date_of_birth,d.neutered,
      (SELECT count(*)::int FROM graph.dog_breeds b WHERE b.dog_id=d.id) AS breed_count,
      (SELECT count(*)::int FROM graph.dog_media m WHERE m.dog_id=d.id AND m.kind='photo' AND m.moderation_state='approved' AND m.deleted_at IS NULL) AS photos,
      EXISTS(SELECT 1 FROM graph.dog_temperament t WHERE t.dog_id=d.id) AS temperament,
      h.cell_coarse IS NOT NULL AS location_ready
      FROM graph.dogs d JOIN identity.households h ON h.id=d.household_id
      JOIN identity.household_members m ON m.household_id=h.id AND m.user_id=$1 AND m.accepted_at IS NOT NULL
      WHERE d.id=$2 AND d.deleted_at IS NULL AND d.status='active' AND h.deleted_at IS NULL`,
    [userId,preference.active_dog_id])).rows[0];
    const household = (await tx.query(`SELECT EXISTS(SELECT 1 FROM identity.household_members m
      JOIN identity.households h ON h.id=m.household_id WHERE m.user_id=$1 AND m.accepted_at IS NOT NULL AND h.deleted_at IS NULL) AS present`,[userId])).rows[0]!.present;
    const verified = (await tx.query(`SELECT EXISTS(SELECT 1 FROM verify.tiers_granted WHERE subject_type='user'
      AND subject_id=$1 AND tier>=1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())) AS present`,[userId])).rows[0]!.present;
    const missing: string[] = [];
    if (!preference.adult_declared) missing.push('adult-declaration');
    for (const purpose of requiredPurposes) {
      const document = documents.find((item) => item.purpose===purpose);
      const consent = consents.find((item) => item.purpose===purpose);
      if (!document) missing.push(`${purpose}-document-unavailable`);
      else if (consent?.document_id!==document.id || consent.action!=='accepted') missing.push(`${purpose}-acceptance`);
    }
    if (!household) missing.push('household');
    if (!dog) missing.push('active-dog');
    else {
      if (!dog.date_of_birth || dog.neutered===null || dog.breed_count===0) missing.push('dog-details');
      if (dog.photos<3) missing.push('approved-photos');
      if (!dog.temperament) missing.push('temperament');
      const locationDocument = documents.find((item)=>item.purpose==='location');
      const locationConsent = consents.find((item)=>item.purpose==='location');
      if (!dog.location_ready || !locationDocument || locationConsent?.document_id!==locationDocument.id || locationConsent.action!=='accepted') missing.push('location');
    }
    if (!verified) missing.push('guardian-verification');
    return { rulesVersion: 1, ready: missing.length===0, missing, nextAction: missing[0] ?? null,
      activeDogId: dog?.id ?? null, completedAt: preference.onboarding_completed_at,
      preferences: { countryCode: user.country_code, locale: user.locale, mode: 'pack', adultDeclared: preference.adult_declared } };
  }
}
