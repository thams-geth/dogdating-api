import { createHash,randomBytes } from 'node:crypto';import type { Pool,PoolClient } from 'pg';
import { transaction } from '../../db/transaction.js';import { socialLock } from '../../db/social-lock.js';import { ApiError } from '../../middleware/error.js';import { page,decodeCursor } from '../../http/pagination.js';
import { requireHousehold } from '../households/access.js';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const projection=`id,dog_id AS "dogId",source_household_id AS "sourceHouseholdId",target_household_id AS "targetHouseholdId",requested_by AS "requestedBy",recipient_user_id AS "recipientUserId",CASE WHEN state='pending' AND expires_at<=now() THEN 'expired' ELSE state END AS state,expires_at AS "expiresAt",created_at AS "createdAt",accepted_at AS "acceptedAt"`;
export class TransfersService {
 constructor(private readonly db:Pool){}
 private async accounts(tx:PoolClient,users:string[]){const rows=(await tx.query("SELECT id,country_code FROM identity.users WHERE id=ANY($1::uuid[]) AND status IN ('active','pending') AND deleted_at IS NULL AND deletion_requested_at IS NULL ORDER BY id FOR UPDATE",[users])).rows;
  if(rows.length!==new Set(users).size||new Set(rows.map(r=>r.country_code)).size!==1)throw new ApiError(404,'not-found','Transfer participant is unavailable in this country.');
 }
 private async households(tx:PoolClient,source:string,target:string,sender:string,recipient:string){
  await tx.query('SELECT id FROM identity.households WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[[source,target]]);
  await requireHousehold(tx,source,sender,['owner']);await requireHousehold(tx,target,recipient,['owner']);
 }
 create(userId:string,dogId:string,targetHouseholdId:string,recipientUserId:string){return transaction(this.db,async tx=>{
  await socialLock(tx);if(userId===recipientUserId)throw new ApiError(400,'two-party-required','Choose a different guardian to accept the transfer.');
  await this.accounts(tx,[userId,recipientUserId]);const dog=(await tx.query('SELECT household_id,status,deleted_at FROM graph.dogs WHERE id=$1',[dogId])).rows[0];if(!dog||dog.deleted_at||dog.status!=='active')throw new ApiError(404,'not-found','Dog is unavailable.');
  if(dog.household_id===targetHouseholdId)throw new ApiError(400,'same-household','Choose a different household.');await this.households(tx,dog.household_id,targetHouseholdId,userId,recipientUserId);
  await tx.query("UPDATE graph.dog_transfers SET state='expired' WHERE dog_id=$1 AND state='pending' AND expires_at<=now()",[dogId]);
  if((await tx.query("SELECT 1 FROM graph.dog_transfers WHERE dog_id=$1 AND state='pending'",[dogId])).rowCount)throw new ApiError(409,'transfer-pending','Cancel the current transfer before starting another.');
  if((await tx.query("SELECT count(*)::int n FROM graph.dog_transfers WHERE requested_by=$1 AND created_at>now()-interval '1 day'",[userId])).rows[0].n>=5)throw new ApiError(429,'transfer-limit','At most five transfer requests per day.');
  const token=randomBytes(32).toString('base64url'),row=(await tx.query(`INSERT INTO graph.dog_transfers(dog_id,source_household_id,target_household_id,requested_by,recipient_user_id,token_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${projection}`,[dogId,dog.household_id,targetHouseholdId,userId,recipientUserId,hash(token)])).rows[0];
  await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES($1,'user','dog.transfer.request','dog',$2)",[userId,dogId]);return {...row,token,recordSharing:['profile','completed_photos','health_metadata']};
 });}
 async list(userId:string,limit:number,cursor?:string){const scope=`transfers:${userId}`,after=decodeCursor(cursor,scope);return page((await this.db.query(`SELECT ${projection} FROM graph.dog_transfers WHERE (requested_by=$1 OR recipient_user_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[userId,after,limit+1])).rows,limit,scope);}
 accept(userId:string,id:string,token:string){return transaction(this.db,async tx=>{
  await socialLock(tx);const row=(await tx.query('SELECT * FROM graph.dog_transfers WHERE id=$1 AND recipient_user_id=$2 AND token_hash=$3',[id,userId,hash(token)])).rows[0];if(!row)throw new ApiError(404,'not-found','Transfer is unavailable.');
  if(row.state==='accepted')return {id,dogId:row.dog_id,state:'accepted'};
  if(row.state!=='pending'||row.expires_at<=new Date())throw new ApiError(409,'transfer-unavailable','Transfer is cancelled or expired.');
  const selected=(await tx.query('SELECT user_id FROM identity.user_preferences WHERE active_dog_id=$1',[row.dog_id])).rows.map(r=>r.user_id);
  const users=[...new Set([userId,row.requested_by,...selected])].sort();await tx.query('SELECT id FROM identity.users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[users]);
  await this.accounts(tx,[userId,row.requested_by]);
  // Clear selection before household locks, preserving the user -> household lock order.
  await tx.query('UPDATE identity.user_preferences SET active_dog_id=NULL,discovery_paused=true,updated_at=now() WHERE active_dog_id=$1',[row.dog_id]);
  await this.households(tx,row.source_household_id,row.target_household_id,row.requested_by,userId);
  const dog=(await tx.query('SELECT household_id,status,deleted_at FROM graph.dogs WHERE id=$1 FOR UPDATE',[row.dog_id])).rows[0];if(!dog||dog.household_id!==row.source_household_id||dog.status!=='active'||dog.deleted_at)throw new ApiError(409,'transfer-unavailable','Dog ownership or status changed.');
  if((await tx.query("SELECT count(*)::int n FROM graph.dogs WHERE household_id=$1 AND status='active' AND deleted_at IS NULL",[row.target_household_id])).rows[0].n>=20)throw new ApiError(409,'dog-limit','Destination household already has twenty active dogs.');
  await tx.query("UPDATE graph.match_preferences SET allow_city_only=false WHERE dog_id=$1",[row.dog_id]);
  await tx.query("UPDATE graph.dogs SET household_id=$2,publication_state='draft',published_by=NULL,updated_at=now() WHERE id=$1",[row.dog_id,row.target_household_id]);
  await tx.query('DELETE FROM graph.dog_availability WHERE dog_id=$1 AND beacon_until IS NOT NULL',[row.dog_id]);
  await tx.query("UPDATE verify.tiers_granted SET revoked_at=now(),revoked_reason='ownership_transferred' WHERE subject_type='dog' AND subject_id=$1 AND revoked_at IS NULL",[row.dog_id]);
  await tx.query("UPDATE verify.verification_requests SET state='withdrawn',updated_at=now() WHERE subject_type='dog' AND subject_id=$1 AND state IN ('pending','in_review','needs_more_info')",[row.dog_id]);
  await tx.query(`WITH unfinished AS(UPDATE graph.media_uploads u SET state='deleted',cleanup_required=true FROM graph.dog_media m WHERE m.id=u.media_id AND m.dog_id=$1 AND u.state IN('awaiting_upload','uploaded') RETURNING u.media_id) UPDATE graph.dog_media SET deleted_at=coalesce(deleted_at,now()) WHERE id IN(SELECT media_id FROM unfinished)`,[row.dog_id]);
  await tx.query("UPDATE meetup.matches SET state='ended',ended_at=now(),ended_by=$2,end_reason='ownership_transferred' WHERE state='active' AND $1 IN(dog_a_id,dog_b_id)",[row.dog_id,userId]);
  await tx.query("UPDATE meetup.conversations SET state='closed' WHERE match_id IN(SELECT id FROM meetup.matches WHERE $1 IN(dog_a_id,dog_b_id))",[row.dog_id]);
  await tx.query("UPDATE graph.dog_transfers SET state='accepted',accepted_at=now() WHERE id=$1",[id]);
  await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES($1,'user','dog.transfer.accept','dog',$2)",[userId,row.dog_id]);return {id,dogId:row.dog_id,state:'accepted'};
 });}
 cancel(userId:string,id:string){return transaction(this.db,async tx=>{await socialLock(tx);const row=(await tx.query('SELECT * FROM graph.dog_transfers WHERE id=$1 AND (requested_by=$2 OR recipient_user_id=$2)',[id,userId])).rows[0];if(!row)throw new ApiError(404,'not-found','Transfer is unavailable.');if(row.state==='accepted')throw new ApiError(409,'transfer-final','Accepted transfers cannot be cancelled.');await tx.query("UPDATE graph.dog_transfers SET state='cancelled' WHERE id=$1 AND state='pending'",[id]);});}
}
