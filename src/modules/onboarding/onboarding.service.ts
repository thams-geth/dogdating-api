import { socialLock } from '../../db/social-lock.js';
import { requireHousehold } from '../households/access.js';
import type { Pool } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { OnboardingRepository, purposes, requiredPurposes } from './onboarding.repository.js';
import type { onboardingPreferencesSchema, preferencesSchema, legalQuery } from './onboarding.schemas.js';

export class OnboardingService {
  private readonly repo = new OnboardingRepository();
  constructor(private readonly database: Pool) {}
  async document(purpose: string, query: z.infer<typeof legalQuery>) {
    const row = (await this.database.query(`SELECT id,purpose,version,country_code AS "countryCode",locale,body,
      content_sha256 AS "contentSha256",published_at AS "publishedAt" FROM identity.policy_documents
      WHERE purpose=$1 AND country_code=$2 AND locale=$3 AND published_at<=now()
      AND ($4::text IS NULL OR version=$4) ORDER BY published_at DESC,id DESC LIMIT 1`,
    [purpose,query.countryCode,query.locale,query.version])).rows[0];
    if (!row) throw new ApiError(404,'document-unavailable','A published document is not available for this request.');
    return row;
  }
  progress(userId: string) { return transaction(this.database,(tx)=>this.repo.snapshot(tx,userId)); }
  saveOnboarding(userId: string, input: z.infer<typeof onboardingPreferencesSchema>) {
    return transaction(this.database,async (tx)=> {
      const user = await this.repo.lockUser(tx,userId);
      if (input.countryCode!==user.country_code) throw new ApiError(409,'country-mismatch','Onboarding cannot change account market.');
      await tx.query(`UPDATE identity.user_preferences SET adult_declared=$2,
        adult_declared_at=CASE WHEN $2 THEN coalesce(adult_declared_at,now()) ELSE NULL END,
        discovery_paused=CASE WHEN $2 THEN discovery_paused ELSE true END,
        onboarding_completed_at=NULL,updated_at=now() WHERE user_id=$1`,[userId,input.adultDeclared]);
      await tx.query('UPDATE identity.users SET locale=$2,updated_at=now() WHERE id=$1',[userId,input.locale]);
      return this.repo.snapshot(tx,userId);
    });
  }
  async consentState(userId: string) {
    return transaction(this.database,async (tx)=> {
      const user = await this.repo.lockUser(tx,userId);
      const documents=await this.repo.documents(tx,user.country_code,user.locale);
      const events=await this.repo.consents(tx,userId);
      return { consents: purposes.map((purpose)=> {
        const doc=documents.find((item)=>item.purpose===purpose); const event=events.find((item)=>item.purpose===purpose);
        return { purpose, required: (requiredPurposes as readonly string[]).includes(purpose),
          currentDocumentId: doc?.id ?? null, currentVersion: doc?.version ?? null,
          status: event?.action ?? 'not-accepted', acceptedDocumentId: event?.action==='accepted' ? event.document_id : null,
          current: !!doc && event?.action==='accepted' && event.document_id===doc.id, recordedAt: event?.recorded_at ?? null };
      }) };
    });
  }
  async accept(userId: string, documentId: string) {
    await transaction(this.database,async (tx)=> {
      const user = await this.repo.lockUser(tx,userId);
      const documents = await this.repo.documents(tx,user.country_code,user.locale);
      const doc=documents.find((item)=>item.id===documentId);
      if (!doc) throw new ApiError(409,'document-not-current','Accept the current published document for your country and locale.');
      const event=(await this.repo.consents(tx,userId)).find((item)=>item.purpose===doc.purpose);
      if (event?.action==='accepted' && event.document_id===doc.id) return;
      await tx.query("INSERT INTO identity.consent_events (user_id,document_id,action) VALUES ($1,$2,'accepted')",[userId,doc.id]);
    });
    return this.consentState(userId);
  }
  async withdraw(userId: string, purpose: string) {
    await transaction(this.database,async (tx)=> {
      await this.repo.lockUser(tx,userId);
      const event=(await this.repo.consents(tx,userId)).find((item)=>item.purpose===purpose);
      if (event?.action==='accepted') await tx.query("INSERT INTO identity.consent_events (user_id,document_id,action) VALUES ($1,$2,'withdrawn')",[userId,event.document_id]);
      if (purpose!=='marketing') await tx.query(`UPDATE identity.user_preferences
        SET discovery_paused=true,onboarding_completed_at=NULL,updated_at=now() WHERE user_id=$1`,[userId]);
    });
  }
  async selectDog(userId: string, dogId: string | null) {
    return transaction(this.database,async (tx)=> {
      await socialLock(tx);
      await this.repo.lockUser(tx,userId);
      if (dogId) {
        const selected=(await tx.query<{household_id:string}>('SELECT household_id FROM graph.dogs WHERE id=$1',[dogId])).rows[0];
        if (!selected) throw new ApiError(404,'not-found','Dog not found.');
        await requireHousehold(tx,selected.household_id,userId);
        const dog = await tx.query(`SELECT d.id FROM graph.dogs d JOIN identity.households h ON h.id=d.household_id
          JOIN identity.household_members m ON m.household_id=h.id AND m.user_id=$1 AND m.accepted_at IS NOT NULL
          WHERE d.id=$2 AND d.status='active' AND d.deleted_at IS NULL AND h.deleted_at IS NULL`,[userId,dogId]);
        if (!dog.rowCount) throw new ApiError(404,'not-found','Dog not found.');
      }
      await tx.query('UPDATE identity.user_preferences SET active_dog_id=$2,onboarding_completed_at=NULL,updated_at=now() WHERE user_id=$1',[userId,dogId]);
      return this.repo.snapshot(tx,userId);
    });
  }
  async preferences(userId: string) {
    const row=(await this.database.query('SELECT discovery_paused AS "discoveryPaused",read_receipts AS "readReceipts" FROM identity.user_preferences WHERE user_id=$1',[userId])).rows[0];
    return row ?? { discoveryPaused: true, readReceipts: true };
  }
  async savePreferences(userId: string, input: z.infer<typeof preferencesSchema>) {
    await transaction(this.database,async (tx)=> {
      await this.repo.lockUser(tx,userId);
      if (input.discoveryPaused===false && !(await this.repo.snapshot(tx,userId)).ready) throw new ApiError(409,'onboarding-incomplete','Complete onboarding before enabling discovery.');
      await tx.query(`UPDATE identity.user_preferences SET discovery_paused=coalesce($2,discovery_paused),
        read_receipts=coalesce($3,read_receipts),updated_at=now() WHERE user_id=$1`,[userId,input.discoveryPaused,input.readReceipts]);
    });
    return this.preferences(userId);
  }
  async complete(userId: string) {
    return transaction(this.database,async (tx)=> {
      const state=await this.repo.snapshot(tx,userId);
      if (!state.ready) throw new ApiError(409,'onboarding-incomplete','Required onboarding steps are missing; fetch onboarding progress.');
      await tx.query(`UPDATE identity.user_preferences SET onboarding_completed_at=coalesce(onboarding_completed_at,now()),
        onboarding_rules_version=1,updated_at=now() WHERE user_id=$1`,[userId]);
      return this.repo.snapshot(tx,userId);
    });
  }
}
