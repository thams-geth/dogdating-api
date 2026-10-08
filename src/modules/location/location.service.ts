import type { Pool } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { decodeCursor, page } from '../../http/pagination.js';
import { requireHousehold } from '../households/access.js';
import { OnboardingRepository } from '../onboarding/onboarding.repository.js';
import { LocationRepository, areaProjection, selectableStates } from './location.repository.js';
import type { areaQuery } from './location.schemas.js';
export class LocationService {
  private readonly repo = new LocationRepository();
  private readonly onboarding = new OnboardingRepository();
  constructor(private readonly db: Pool) {}
  async areas(query: z.infer<typeof areaQuery>) {
    const scope = `areas:${query.countryCode}:${query.query.toLowerCase()}`, after = decodeCursor(query.cursor, scope);
    const rows = (await this.db.query(`SELECT ${areaProjection} FROM ops.metros
      WHERE country=$1 AND launch_state<>'prospect' AND strpos(lower(name),lower($2))>0
      AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`, [query.countryCode, query.query, after, query.limit + 1])).rows;
    const result = page(rows as ({id:string}&Record<string,unknown>)[], query.limit, scope);
    return { areas: result.items, nextCursor: result.nextCursor };
  }
  get(userId: string, householdId: string) { return transaction(this.db, async tx => {
    await requireHousehold(tx, householdId, userId); return this.repo.status(tx, householdId);
  }); }
  save(userId: string, householdId: string, areaId: string) { return transaction(this.db, async tx => {
    const user = await this.onboarding.lockUser(tx, userId);
    await requireHousehold(tx, householdId, userId, ['owner', 'co_guardian']);
    const documents = await this.onboarding.documents(tx, user.country_code, user.locale);
    const document = documents.find(d => d.purpose === 'location');
    const consent = (await this.onboarding.consents(tx, userId)).find(c => c.purpose === 'location');
    if (!document || consent?.document_id !== document.id || consent.action !== 'accepted') {
      throw new ApiError(409, 'location-consent-required', 'Accept the current location document before saving an area.');
    }
    const area = (await tx.query('SELECT country,launch_state FROM ops.metros WHERE id=$1', [areaId])).rows[0];
    if (!area || area.country !== user.country_code || !selectableStates.includes(area.launch_state)) {
      throw new ApiError(409, 'area-unavailable', 'Choose a selectable area in your account country.');
    }
    const h = (await tx.query('SELECT location_source,metro_id,location_change_after FROM identity.households WHERE id=$1', [householdId])).rows[0]!;
    if (h.location_source === 'manual_area' && h.metro_id === areaId) return this.repo.status(tx, householdId);
    if (h.location_change_after && h.location_change_after > new Date()) throw new ApiError(429, 'location-change-limited', 'Area changes are limited to once every 24 hours; read location for canChangeAt.');
    await tx.query(`UPDATE identity.households SET location_source='manual_area',metro_id=$2,location_updated_at=now(),
      location_change_after=now()+interval '24 hours',cell_coarse=NULL,cell_fine=NULL,h3_r8=NULL,
      anchor_origin_lat=NULL,anchor_origin_lon=NULL,anchor_set_at=NULL,updated_at=now() WHERE id=$1`, [householdId, areaId]);
    await this.repo.invalidate(tx, householdId);
    await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','location.set','household',$2)", [userId, householdId]);
    return this.repo.status(tx, householdId);
  }); }
  clear(userId: string, householdId: string) { return transaction(this.db, async tx => {
    await requireHousehold(tx, householdId, userId, ['owner', 'co_guardian']);
    // Removal is always permitted. Retain the change deadline so delete/recreate cannot bypass throttling.
    await tx.query(`UPDATE identity.households SET location_source=NULL,metro_id=NULL,location_updated_at=NULL,
      cell_coarse=NULL,cell_fine=NULL,h3_r8=NULL,anchor_origin_lat=NULL,anchor_origin_lon=NULL,anchor_set_at=NULL,updated_at=now() WHERE id=$1`, [householdId]);
    await this.repo.invalidate(tx, householdId);
    await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user','location.clear','household',$2)", [userId, householdId]);
  }); }
}
