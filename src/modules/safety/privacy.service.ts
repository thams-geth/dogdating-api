import type { MessageCipher } from '../messages/message-cipher.js';
import { exportScope,exportExclusions } from './account-export.js';
import { createHash,randomBytes } from 'node:crypto';import type { Pool,PoolClient } from 'pg';
import { transaction } from '../../db/transaction.js';import { socialLock } from '../../db/social-lock.js';import { ApiError } from '../../middleware/error.js';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export class PrivacyService {
 constructor(private readonly db:Pool,private readonly cipher?:MessageCipher){}
 private async recent(tx:PoolClient,userId:string,familyId?:string){
  if(!familyId)return; // Restricted privacy credential itself proves OTP within 30 minutes.
  const row=(await tx.query('SELECT min(created_at)>now()-interval \'15 minutes\' AS recent FROM identity.sessions WHERE user_id=$1 AND family_id=$2',[userId,familyId])).rows[0];
  if(!row?.recent)throw new ApiError(403,'reauthentication-required','Verify your phone again before this action.');
 }
 request(userId:string,kind:'export'|'deletion',familyId?:string){return transaction(this.db,async tx=>{
  if(kind==='export'&&!this.cipher)throw new ApiError(503,'export-storage-unavailable','Private export storage is not configured.');
  await socialLock(tx);await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);await this.recent(tx,userId,familyId);
  const token=randomBytes(32).toString('base64url');let row=(await tx.query("SELECT id FROM identity.privacy_requests WHERE user_id=$1 AND kind=$2 AND state IN ('queued','processing','needs_review')",[userId,kind])).rows[0];
  if(row)row=(await tx.query('UPDATE identity.privacy_requests SET status_token_hash=$2 WHERE id=$1 RETURNING id,kind,state,created_at AS "createdAt"',[row.id,hash(token)])).rows[0];
  else{
   if((await tx.query("SELECT count(*)::int n FROM identity.privacy_requests WHERE user_id=$1 AND created_at>now()-interval '1 day'",[userId])).rows[0].n>=3)throw new ApiError(429,'privacy-request-limit','Daily privacy request limit reached.');
   row=(await tx.query(`INSERT INTO identity.privacy_requests(user_id,kind,status_token_hash,state,export_scope) VALUES($1,$2,$3,$4,$5) RETURNING id,kind,state,created_at AS "createdAt"`,[userId,kind,hash(token),kind==='export'?'queued':'needs_review',kind==='export'?exportScope:null])).rows[0];
  }
  if(kind==='deletion'){
   await tx.query('UPDATE identity.users SET deletion_requested_at=coalesce(deletion_requested_at,now()),updated_at=now() WHERE id=$1',[userId]);
   await tx.query('UPDATE identity.user_preferences SET discovery_paused=true WHERE user_id=$1',[userId]);
   await tx.query("UPDATE identity.sessions SET revoked_at=coalesce(revoked_at,now()),revoked_reason='deletion_requested' WHERE user_id=$1",[userId]);
   await tx.query('DELETE FROM identity.devices WHERE user_id=$1',[userId]);
   await tx.query("UPDATE graph.dogs SET publication_state='paused' WHERE published_by=$1",[userId]);
   await tx.query('DELETE FROM graph.dog_availability WHERE dog_id IN(SELECT id FROM graph.dogs WHERE published_by=$1) AND beacon_until IS NOT NULL',[userId]);
   await tx.query(`UPDATE meetup.matches SET state='ended',ended_at=now(),ended_by=$1,end_reason='deletion_requested' WHERE state='active' AND id IN (SELECT c.match_id FROM meetup.conversations c JOIN meetup.conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=$1)`,[userId]);
   await tx.query("UPDATE meetup.conversations SET state='closed' WHERE match_id IN(SELECT id FROM meetup.matches WHERE ended_by=$1 AND end_reason='deletion_requested')",[userId]);
  }
  return {...row,statusToken:token,nextAction:row.state==='queued'?'awaiting_export_generation':'awaiting_privacy_review',completed:false,...(kind==='export'?{scope:exportScope,excludedCategories:exportExclusions}:{})};
 });}
 async status(id:string,token:string,kind:'export'|'deletion'){
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApiError(401,'invalid-status-token','A request status token is required.');
  const row=(await this.db.query('SELECT id,kind,state,created_at AS "createdAt",updated_at AS "updatedAt",error_code AS "errorCode",expires_at AS "expiresAt",export_scope AS scope FROM identity.privacy_requests WHERE id=$1 AND status_token_hash=$2 AND kind=$3',[id,hash(token),kind])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Privacy request is unavailable.');
  const expired=row.expiresAt&&new Date(row.expiresAt)<=new Date();
  return {...row,...(expired&&row.state==='ready'?{state:'failed',errorCode:'export-expired'}:{}),downloadAvailable:row.state==='ready'&&!expired};
 }
 download(userId:string,id:string,familyId?:string){return transaction(this.db,async tx=>{
  if(!this.cipher)throw new ApiError(503,'export-storage-unavailable','Private export storage is not configured.');
  await this.recent(tx,userId,familyId);
  const row=(await tx.query("SELECT state,result_encrypted,expires_at FROM identity.privacy_requests WHERE id=$1 AND user_id=$2 AND kind='export'",[id,userId])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Export is unavailable.');
  if(row.expires_at&&new Date(row.expires_at)<=new Date())throw new ApiError(410,'export-expired','Request a new export.');
  if(row.state!=='ready'||!row.result_encrypted)throw new ApiError(409,'export-not-ready','Wait for export processing or privacy review.');
  const artifact=JSON.parse(this.cipher.unwrap(row.result_encrypted,`export:${id}:${userId}`).toString('utf8'));
  await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES($1,'user','privacy.export.download','privacy_request',$2)",[userId,id]);return artifact;
 });}
}
