import type { Pool,PoolClient } from 'pg';
import { transaction } from '../../db/transaction.js';
import { open,type MessageCipher } from '../messages/message-cipher.js';
export const exportScope='account_data_v1';
export const exportExclusions=['photo_file_bytes','other_people_messages_and_profiles','shared_household_documents','provider_records','internal_security_and_staff_notes'];
const maxRows=10000,maxBytes=20*1024*1024;
class ExportLimit extends Error {}
async function build(tx:PoolClient,userId:string,cipher:MessageCipher){
 let totalBytes=0;
 const data:Record<string,unknown>={};
 const add=(name:string,rows:unknown[])=>{if(rows.length>maxRows)throw new ExportLimit();totalBytes+=Buffer.byteLength(JSON.stringify(rows));if(totalBytes>maxBytes)throw new ExportLimit();data[name]=rows;};
 const queries:Record<string,string>={
  profile:`SELECT id,phone_e164 AS "phoneE164",email,display_name AS "displayName",date_of_birth::text AS "dateOfBirth",is_adult_verified AS "isAdultVerified",country_code AS "countryCode",residency_region AS "residencyRegion",locale,timezone,status,created_at AS "createdAt",deletion_requested_at AS "deletionRequestedAt" FROM identity.users WHERE id=$1`,
  preferences:`SELECT mode,adult_declared AS "adultDeclared",adult_declared_at AS "adultDeclaredAt",active_dog_id AS "activeDogId",discovery_paused AS "discoveryPaused",read_receipts AS "readReceipts",onboarding_completed_at AS "onboardingCompletedAt" FROM identity.user_preferences WHERE user_id=$1`,
  notificationPreferences:`SELECT messages,connections,meetups,push_enabled AS "pushEnabled",timezone,quiet_start AS "quietStart",quiet_end AS "quietEnd" FROM identity.notification_preferences WHERE user_id=$1`,
  consents:`SELECT e.id::text,e.action,e.recorded_at AS "recordedAt",d.id AS "documentId",d.purpose,d.version,d.locale,d.content_sha256 AS "documentHash" FROM identity.consent_events e JOIN identity.policy_documents d ON d.id=e.document_id WHERE e.user_id=$1 ORDER BY e.id`,
  memberships:`SELECT household_id AS "householdId",role,accepted_at AS "acceptedAt" FROM identity.household_members WHERE user_id=$1 ORDER BY household_id`,
  sessions:`SELECT device_id AS "deviceId",created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",revoked_reason AS "revokedReason" FROM identity.sessions WHERE user_id=$1 ORDER BY created_at,id`,
  waitlist:`SELECT id,metro_id AS "metroId",created_at AS "createdAt" FROM identity.waitlist WHERE user_id=$1 ORDER BY id`,
  decisions:`SELECT id,actor_dog_id AS "actorDogId",target_dog_id AS "targetDogId",mode,verdict,decided_at AS "decidedAt",withdrawn_at AS "withdrawnAt" FROM meetup.decisions WHERE requested_by=$1 ORDER BY id`,
  attendance:`SELECT meetup_id AS "meetupId",dog_id AS "dogId",rsvp,checked_in_at AS "checkedInAt",checked_out_at AS "checkedOutAt" FROM meetup.meetup_participants WHERE user_id=$1 ORDER BY meetup_id,dog_id`,
  uploads:`SELECT u.media_id AS "mediaId",m.dog_id AS "dogId",u.content_type AS "contentType",u.state,m.moderation_state AS "moderationState",u.created_at AS "createdAt",u.completed_at AS "completedAt" FROM graph.media_uploads u JOIN graph.dog_media m ON m.id=u.media_id WHERE u.created_by=$1 ORDER BY u.media_id`,
  verificationRequests:`SELECT id,subject_type AS "subjectType",subject_id AS "subjectId",target_tier AS "targetTier",state,decision_reason_code AS "reasonCode",created_at AS "createdAt" FROM verify.verification_requests WHERE requested_by=$1 ORDER BY id`,
  authoredHealthRecords:`SELECT id,dog_id AS "dogId",record_type AS "recordType",tested_at::text AS "testedAt",expires_at::text AS "expiresAt",result_code AS "resultCode",verified_at AS "verifiedAt",deleted_at AS "deletedAt" FROM verify.health_records WHERE created_by=$1 ORDER BY id`,
  notifications:`SELECT id,category,conversation_id AS "conversationId",created_at AS "createdAt",read_at AS "readAt" FROM identity.notifications WHERE user_id=$1 ORDER BY id`,
  supportTickets:`SELECT id,category,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM safety.support_tickets WHERE user_id=$1 ORDER BY id`,
  safetyNotices:`SELECT id,action,reason_code AS "reasonCode",policy_ref AS "policyRef",created_at AS "createdAt",expires_at AS "expiresAt",reversed_at AS "reversedAt" FROM safety.enforcement_actions WHERE subject_type='user' AND subject_id=$1 ORDER BY id`,
 };
 for(const [name,sql]of Object.entries(queries))add(name,(await tx.query(`${sql} LIMIT ${maxRows+1}`,[userId])).rows);
 const messages=(await tx.query(`SELECT m.message_id,m.conversation_id,m.seq,m.kind,m.body_encrypted,m.created_at,m.deleted_at,k.wrapped_key FROM meetup.messages m LEFT JOIN meetup.conversation_keys k ON k.conversation_id=m.conversation_id WHERE m.sender_user_id=$1 ORDER BY m.conversation_id,m.seq LIMIT $2`,[userId,maxRows+1])).rows;
 add('authoredMessages',messages.map(r=>({id:r.message_id,conversationId:r.conversation_id,seq:r.seq,kind:r.kind,body:r.deleted_at||!r.body_encrypted?null:open(cipher.unwrap(r.wrapped_key,r.conversation_id),r.body_encrypted,`${r.conversation_id}:${r.message_id}`).toString('utf8'),createdAt:r.created_at,deletedAt:r.deleted_at})));
 const reports=(await tx.query('SELECT id,subject_type,subject_id,category,state,narrative_encrypted,created_at FROM safety.reports WHERE reporter_user_id=$1 ORDER BY id LIMIT $2',[userId,maxRows+1])).rows;
 add('reports',reports.map(r=>({id:r.id,subjectType:r.subject_type,subjectId:r.subject_id,category:r.category,state:r.state,details:r.narrative_encrypted?cipher.unwrap(r.narrative_encrypted,`report:${r.id}`).toString('utf8'):null,createdAt:r.created_at})));
 const appeals=(await tx.query('SELECT id,action_id,state,statement_encrypted,outcome,created_at FROM safety.appeals WHERE user_id=$1 ORDER BY id LIMIT $2',[userId,maxRows+1])).rows;
 add('appeals',appeals.map(r=>({id:r.id,actionId:r.action_id,state:r.state,statement:r.statement_encrypted?cipher.unwrap(r.statement_encrypted,`appeal:${r.id}`).toString('utf8'):null,outcome:r.outcome,createdAt:r.created_at})));
 const support=(await tx.query('SELECT m.id,m.ticket_id,m.body_encrypted,m.created_at FROM safety.support_messages m WHERE m.author_user_id=$1 ORDER BY m.id LIMIT $2',[userId,maxRows+1])).rows;
 add('authoredSupportMessages',support.map(r=>({id:r.id,ticketId:r.ticket_id,body:cipher.unwrap(r.body_encrypted,`support:${r.id}`).toString('utf8'),createdAt:r.created_at})));
 const reviews=(await tx.query('SELECT id,meetup_id,showed_up,on_time,dog_as_described,human_respectful,play_compatibility,would_repeat,incident_occurred,incident_type,private_note_encrypted,public_note,created_at FROM meetup.meetup_reviews WHERE reviewer_user_id=$1 ORDER BY id LIMIT $2',[userId,maxRows+1])).rows;
 add('authoredReviews',reviews.map(r=>({id:r.id,meetupId:r.meetup_id,showedUp:r.showed_up,onTime:r.on_time,dogAsDescribed:r.dog_as_described,humanRespectful:r.human_respectful,playCompatibility:r.play_compatibility,wouldRepeat:r.would_repeat,incidentOccurred:r.incident_occurred,incidentType:r.incident_type,privateNote:r.private_note_encrypted?cipher.unwrap(r.private_note_encrypted,`review:${r.id}`).toString('utf8'):null,publicNote:r.public_note,createdAt:r.created_at})));
 const generatedAt=(await tx.query('SELECT transaction_timestamp() AS value')).rows[0].value;
 return {formatVersion:1,scope:exportScope,generatedAt,excludedCategories:exportExclusions,data};
}
export async function processAccountExports(db:Pool,cipher:MessageCipher,limit=10){
 const candidates=(await db.query("SELECT id,user_id FROM identity.privacy_requests WHERE kind='export' AND state='queued' AND export_scope=$1 ORDER BY created_at,id LIMIT $2",[exportScope,Math.min(limit,10)])).rows;
 let ready=0,needsReview=0;
 for(const candidate of candidates){
  try{const processed=await transaction(db,async tx=>{
   await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
   if(!(await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.user_id])).rowCount)return false;
   const row=(await tx.query("SELECT id FROM identity.privacy_requests WHERE id=$1 AND state='queued' FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!row)return false;
   const artifact=Buffer.from(JSON.stringify(await build(tx,candidate.user_id,cipher)));
   if(artifact.length>maxBytes)throw new ExportLimit();
   await tx.query("UPDATE identity.privacy_requests SET state='ready',result_encrypted=$2,expires_at=now()+interval '24 hours',error_code=NULL,updated_at=now() WHERE id=$1",[candidate.id,cipher.wrap(artifact,`export:${candidate.id}:${candidate.user_id}`)]);
   await tx.query("INSERT INTO ops.audit_log(actor_kind,action,subject_type,subject_id) VALUES('system','privacy.export.ready','privacy_request',$1)",[candidate.id]);return true;
  });if(processed)ready++;
  }catch(error){
   const code=(error as {code?:string}).code;if(code==='40001'||code==='40P01')continue;
   const changed=await db.query("UPDATE identity.privacy_requests SET state='needs_review',error_code=$2,result_encrypted=NULL,updated_at=now() WHERE id=$1 AND state='queued'",[candidate.id,error instanceof ExportLimit?'export-size-limit':'export-generation-failed']);needsReview+=changed.rowCount??0;
  }
 }
 const expired=await db.query("UPDATE identity.privacy_requests SET state='failed',result_encrypted=NULL,error_code='export-expired',updated_at=now() WHERE kind='export' AND state='ready' AND expires_at<=now()");
 return {ready,needsReview,expired:expired.rowCount??0};
}
