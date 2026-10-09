import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { socialLock } from '../../db/social-lock.js';
import { ApiError } from '../../middleware/error.js';

const eventSchema=z.object({
 provider:z.string().regex(/^[a-z0-9_-]{2,40}$/),eventId:z.string().min(1).max(120),
 requestId:z.string().uuid(),providerRef:z.string().min(1).max(200),
 subjectType:z.enum(['user','dog']),subjectId:z.string().uuid(),
 assurance:z.enum(['adult_identity','dog_identity']),outcome:z.enum(['approved','rejected','needs_more_info']),
 expiresAt:z.string().datetime({offset:true}).nullable(),
}).strict();
export type VerifiedProviderEvent=z.infer<typeof eventSchema>;
// A selected vendor adapter must verify its actual raw-body signature, timestamp
// and source before returning this normalized event. No default verifier exists.
export interface VerificationEventVerifier {verify(raw:Buffer,headers:IncomingHttpHeaders):Promise<VerifiedProviderEvent>;}
export class VerificationProviderEvents {
 constructor(private readonly db:Pool,private readonly verifier?:VerificationEventVerifier){}
 async handle(raw:unknown,headers:IncomingHttpHeaders){
  if(!this.verifier)throw new ApiError(503,'verification-provider-unavailable','Verification provider is not configured.');
  if(!Buffer.isBuffer(raw)||raw.length===0||raw.length>16*1024)throw new ApiError(400,'invalid-provider-event','Valid provider event bytes are required.');
  let untrusted:VerifiedProviderEvent;
  try{untrusted=await this.verifier.verify(raw,headers);}catch{throw new ApiError(401,'provider-unauthenticated','Valid provider authentication is required.');}
  const event=eventSchema.parse(untrusted),hash=createHash('sha256').update(raw).digest('hex');
  if(event.outcome==='approved'){
   const expiry=new Date(event.expiresAt??'').getTime();
   if(!Number.isFinite(expiry)||expiry<Date.now()+3600000||expiry>Date.now()+366*86400000)throw new ApiError(400,'invalid-provider-event','Approved evidence needs a future expiry within one year.');
  }else if(event.expiresAt!==null)throw new ApiError(400,'invalid-provider-event','Only approved evidence can have an expiry.');
  if(event.subjectType==='user'&&event.assurance!=='adult_identity'||event.subjectType==='dog'&&event.assurance!=='dog_identity')throw new ApiError(400,'invalid-provider-event','Evidence assurance does not match its subject.');
  return transaction(this.db,async tx=>{
   await socialLock(tx);
   const previous=(await tx.query('SELECT request_id,body_hash FROM verify.provider_events WHERE provider=$1 AND event_id=$2',[event.provider,event.eventId])).rows[0];
   if(previous){if(previous.body_hash!==hash||previous.request_id!==event.requestId)throw new ApiError(409,'provider-event-conflict','Provider event ID was already used.');return {accepted:true,requestId:event.requestId,duplicate:true};}
   // Match intake/withdrawal lock order: user first, then request. Re-read the
   // locked request in case its state changed while waiting for the user lock.
   const owner=(await tx.query('SELECT requested_by FROM verify.verification_requests WHERE id=$1',[event.requestId])).rows[0];
   if(!owner?.requested_by)throw new ApiError(404,'verification-request-unavailable','Verification request is unavailable.');
   const user=(await tx.query('SELECT status,deleted_at,deletion_requested_at FROM identity.users WHERE id=$1 FOR UPDATE',[owner.requested_by])).rows[0];
   const request=(await tx.query('SELECT id,subject_type,subject_id,target_tier,requested_by,state FROM verify.verification_requests WHERE id=$1 FOR UPDATE',[event.requestId])).rows[0];
   if(!request||request.requested_by!==owner.requested_by||request.subject_type!==event.subjectType||request.subject_id!==event.subjectId||request.target_tier!==(event.subjectType==='user'?1:2))throw new ApiError(404,'verification-request-unavailable','Verification request is unavailable.');
   if(!['pending','in_review','needs_more_info'].includes(request.state))throw new ApiError(409,'verification-final','Verification request is already final.');
   if(!user||!['pending','active'].includes(user.status)||user.deleted_at||user.deletion_requested_at)throw new ApiError(409,'verification-subject-unavailable','Verification subject is no longer eligible.');
   if(event.subjectType==='user'){
    if(request.subject_id!==request.requested_by)throw new ApiError(409,'verification-subject-unavailable','Verification subject changed.');
   }else{
    await tx.query('SELECT h.id FROM identity.households h JOIN graph.dogs d ON d.household_id=h.id WHERE d.id=$1 FOR UPDATE OF h',[event.subjectId]);
    const current=(await tx.query(`SELECT 1 FROM graph.dogs d JOIN identity.household_members m ON m.household_id=d.household_id
     WHERE d.id=$1 AND d.status='active' AND d.deleted_at IS NULL AND m.user_id=$2
       AND m.accepted_at IS NOT NULL AND m.role IN ('owner','co_guardian')`,[event.subjectId,request.requested_by])).rowCount;
    if(!current)throw new ApiError(409,'verification-subject-unavailable','Dog ownership or status changed.');
   }
   await tx.query('INSERT INTO verify.provider_events(provider,event_id,request_id,body_hash,outcome) VALUES($1,$2,$3,$4,$5)',[event.provider,event.eventId,event.requestId,hash,event.outcome]);
   await tx.query(`UPDATE verify.verification_requests SET provider=$2,provider_ref=$3,state=$4::verify.request_state,
    decision_reason_code=$5,decided_at=CASE WHEN $4='needs_more_info' THEN NULL ELSE now() END,updated_at=now()
    WHERE id=$1`,[event.requestId,event.provider,event.providerRef,event.outcome,event.outcome==='rejected'?'provider_rejected':event.outcome==='needs_more_info'?'additional_evidence_required':null]);
   if(event.outcome==='approved'){
    await tx.query(`INSERT INTO verify.tiers_granted(subject_type,subject_id,tier,expires_at,source_request)
     VALUES($1::verify.subject_type,$2,$3,$4,$5) ON CONFLICT(subject_type,subject_id,tier)
     DO UPDATE SET granted_at=now(),expires_at=excluded.expires_at,revoked_at=NULL,revoked_reason=NULL,source_request=excluded.source_request`,[event.subjectType,event.subjectId,request.target_tier,event.expiresAt,event.requestId]);
    if(event.subjectType==='user')await tx.query('UPDATE identity.users SET is_adult_verified=true,updated_at=now() WHERE id=$1',[event.subjectId]);
   }
   await tx.query("INSERT INTO ops.audit_log(actor_kind,action,subject_type,subject_id) VALUES('system',$1,'verification',$2)",[ `verification.provider.${event.outcome}`,event.requestId]);
   return {accepted:true,requestId:event.requestId,duplicate:false};
  });
 }
}
