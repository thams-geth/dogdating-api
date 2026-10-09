import { randomUUID } from 'node:crypto';import type { Pool,PoolClient } from 'pg';
import { transaction } from '../../db/transaction.js';import { socialLock } from '../../db/social-lock.js';import { ApiError } from '../../middleware/error.js';
import { page,decodeCursor } from '../../http/pagination.js';import type { StaffPrincipal } from './staff-auth.js';import type { MessageCipher } from '../messages/message-cipher.js';
export class AdminService {
 constructor(private readonly db:Pool,private readonly cipher?:MessageCipher){}
 private cipherRequired(){if(!this.cipher)throw new ApiError(503,'case-decryption-unavailable','Case decryption is not configured.');return this.cipher;}
 private audit(tx:PoolClient,staff:StaffPrincipal,action:string,type:string,id?:string){return tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES($1,'staff',$2,$3,$4)",[staff.id,action,type,id??null]);}
 reports(staff:StaffPrincipal,limit:number,cursor?:string){return transaction(this.db,async tx=>{const scope='admin:reports',after=decodeCursor(cursor,scope);await this.audit(tx,staff,'reports.list','report');return page((await tx.query(`SELECT id,subject_type AS "subjectType",category,severity,state,assigned_staff_id AS "assignedStaffId",created_at AS "createdAt" FROM safety.reports WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,[after,limit+1])).rows,limit,scope);});}
 claim(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  const row=(await tx.query('SELECT state,assigned_staff_id FROM safety.reports WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Report is unavailable.');
  if(!['queued','in_review','escalated'].includes(row.state)||row.assigned_staff_id&&row.assigned_staff_id!==staff.id)throw new ApiError(409,'case-unavailable','Case is closed or assigned to another reviewer.');
  await tx.query("UPDATE safety.reports SET assigned_staff_id=$2,state='in_review',first_action_at=coalesce(first_action_at,now()) WHERE id=$1",[id,staff.id]);await this.audit(tx,staff,'report.claim','report',id);return {id,state:'in_review'};
 });}
 report(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  const row=(await tx.query('SELECT id,subject_type,subject_id,category,narrative_encrypted,state FROM safety.reports WHERE id=$1 AND assigned_staff_id=$2',[id,staff.id])).rows[0];if(!row)throw new ApiError(404,'not-found','Claim the case before viewing its narrative.');await this.audit(tx,staff,'report.read','report',id);
  return {id:row.id,subjectType:row.subject_type,subjectId:row.subject_id,category:row.category,state:row.state,details:row.narrative_encrypted?this.cipherRequired().unwrap(row.narrative_encrypted,`report:${id}`).toString('utf8'):null};
 });}
 decideReport(staff:StaffPrincipal,id:string,decision:'dismissed'|'escalated',reason:string){return transaction(this.db,async tx=>{
  const row=(await tx.query('SELECT state FROM safety.reports WHERE id=$1 AND assigned_staff_id=$2 FOR UPDATE',[id,staff.id])).rows[0];if(!row)throw new ApiError(404,'not-found','Assigned case is unavailable.');if(row.state!=='in_review')throw new ApiError(409,'case-final','Case is not in review.');
  await tx.query("UPDATE safety.reports SET state=$2::safety.report_state,resolved_at=CASE WHEN $2='dismissed' THEN now() ELSE NULL END,evidence=jsonb_build_object('decisionReason',$3::text) WHERE id=$1",[id,decision,reason]);await this.audit(tx,staff,`report.${decision}`,'report',id);return {id,state:decision};
 });}
 incidents(staff:StaffPrincipal,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  const scope='admin:meetup-incidents',after=decodeCursor(cursor,scope);
  await this.audit(tx,staff,'meetup_incidents.list','meetup_incident');
  return page((await tx.query(`SELECT c.id,c.state,c.assigned_staff_id AS "assignedStaffId",r.incident_occurred AS "incidentOccurred",r.incident_type AS "incidentType",c.created_at AS "createdAt" FROM safety.meetup_incident_cases c JOIN meetup.meetup_reviews r ON r.id=c.review_id WHERE ($1::uuid IS NULL OR c.id>$1) ORDER BY c.id LIMIT $2`,[after,limit+1])).rows,limit,scope);
 });}
 claimIncident(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  const row=(await tx.query('SELECT state,assigned_staff_id FROM safety.meetup_incident_cases WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Incident case is unavailable.');
  if(!['queued','in_review'].includes(row.state)||(row.assigned_staff_id&&row.assigned_staff_id!==staff.id))throw new ApiError(409,'case-unavailable','Incident case is closed or claimed by another reviewer.');
  await tx.query("UPDATE safety.meetup_incident_cases SET state='in_review',assigned_staff_id=$2,first_action_at=coalesce(first_action_at,now()) WHERE id=$1",[id,staff.id]);
  await this.audit(tx,staff,'meetup_incident.claim','meetup_incident',id);return {id,state:'in_review'};
 });}
 incident(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  const row=(await tx.query(`SELECT c.id,c.state,c.review_id,r.meetup_id,r.reviewer_user_id,r.incident_occurred,r.incident_type,r.private_note_encrypted
   FROM safety.meetup_incident_cases c JOIN meetup.meetup_reviews r ON r.id=c.review_id WHERE c.id=$1 AND c.assigned_staff_id=$2`,[id,staff.id])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Claim the incident before viewing private details.');
  const privateNote=row.private_note_encrypted?this.cipherRequired().unwrap(row.private_note_encrypted,`review:${row.review_id}`).toString('utf8'):null;
  await this.audit(tx,staff,'meetup_incident.read','meetup_incident',id);
  return {id,state:row.state,reviewId:row.review_id,meetupId:row.meetup_id,reporterUserId:row.reviewer_user_id,incidentOccurred:row.incident_occurred,incidentType:row.incident_type,privateNote};
 });}
 decideIncident(staff:StaffPrincipal,id:string,decision:'dismissed'|'escalated',reasonCode:string){return transaction(this.db,async tx=>{
  const row=(await tx.query('SELECT state FROM safety.meetup_incident_cases WHERE id=$1 AND assigned_staff_id=$2 FOR UPDATE',[id,staff.id])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Assigned incident is unavailable.');
  if(row.state!=='in_review')throw new ApiError(409,'case-final','Incident case is already decided.');
  await tx.query('UPDATE safety.meetup_incident_cases SET state=$2,reason_code=$3,decided_at=now() WHERE id=$1',[id,decision,reasonCode]);
  await this.audit(tx,staff,`meetup_incident.${decision}`,'meetup_incident',id);return {id,state:decision};
 });}
 user(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{const row=(await tx.query('SELECT id,status,country_code AS "countryCode",deletion_requested_at AS "deletionRequestedAt",created_at AS "createdAt" FROM identity.users WHERE id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','User is unavailable.');await this.audit(tx,staff,'user.read','user',id);return row;});}
 userAction(staff:StaffPrincipal,id:string,input:{action:'suspend'|'reinstate';reasonCode:string;policyRef:string}){return transaction(this.db,async tx=>{
  await socialLock(tx);const user=(await tx.query('SELECT status,deletion_requested_at FROM identity.users WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!user)throw new ApiError(404,'not-found','User is unavailable.');if(user.deletion_requested_at||user.status==='deleted')throw new ApiError(409,'privacy-request-active','Account is in privacy processing.');
  if(input.action==='suspend'){
   if(!['pending','active'].includes(user.status))throw new ApiError(409,'user-state-conflict','Account cannot be suspended from its current state.');
   const actionId=randomUUID();await tx.query(`INSERT INTO safety.enforcement_actions(id,subject_type,subject_id,action,reason_code,policy_ref,decided_by_staff,previous_user_status) VALUES($1,'user',$2,'suspend',$3,$4,$5,$6)`,[actionId,id,input.reasonCode,input.policyRef,staff.id,user.status]);
   await tx.query("UPDATE identity.users SET status='suspended',updated_at=now() WHERE id=$1",[id]);await tx.query("UPDATE identity.sessions SET revoked_at=coalesce(revoked_at,now()),revoked_reason='suspended' WHERE user_id=$1",[id]);await tx.query('DELETE FROM identity.devices WHERE user_id=$1',[id]);
   await tx.query("UPDATE graph.dogs SET publication_state='paused' WHERE published_by=$1",[id]);
   await tx.query(`UPDATE meetup.matches SET state='ended',ended_at=now(),ended_by=$1,end_reason='account_suspended' WHERE state='active' AND id IN(SELECT c.match_id FROM meetup.conversations c JOIN meetup.conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=$1)`,[id]);
   await tx.query("UPDATE meetup.conversations SET state='closed' WHERE match_id IN(SELECT id FROM meetup.matches WHERE ended_by=$1 AND end_reason='account_suspended')",[id]);await this.audit(tx,staff,'user.suspend','user',id);return {id,status:'suspended',actionId};
  }
  const action=(await tx.query("SELECT id,previous_user_status FROM safety.enforcement_actions WHERE subject_type='user' AND subject_id=$1 AND action='suspend' AND reversed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[id])).rows[0];if(user.status!=='suspended'||!action?.previous_user_status)throw new ApiError(409,'user-state-conflict','No reversible suspension exists.');
  await tx.query('UPDATE safety.enforcement_actions SET reversed_at=now(),reversal_reason=$2 WHERE id=$1',[action.id,input.reasonCode]);await tx.query('UPDATE identity.users SET status=$2,updated_at=now() WHERE id=$1',[id,action.previous_user_status]);await this.audit(tx,staff,'user.reinstate','user',id);return {id,status:action.previous_user_status,actionId:action.id};
 });}
 appeals(staff:StaffPrincipal,limit:number,cursor?:string){return transaction(this.db,async tx=>{const scope='admin:appeals',after=decodeCursor(cursor,scope);await this.audit(tx,staff,'appeals.list','appeal');return page((await tx.query('SELECT id,action_id AS "actionId",state,created_at AS "createdAt" FROM safety.appeals WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',[after,limit+1])).rows,limit,scope);});}
 appeal(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{const row=(await tx.query('SELECT a.id,a.state,a.statement_encrypted,e.decided_by_staff,e.reason_code,e.policy_ref FROM safety.appeals a JOIN safety.enforcement_actions e ON e.id=a.action_id WHERE a.id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Appeal is unavailable.');if(row.decided_by_staff===staff.id)throw new ApiError(403,'independent-review-required','Another staff member must review this appeal.');await this.audit(tx,staff,'appeal.read','appeal',id);return {id,state:row.state,statement:row.statement_encrypted?this.cipherRequired().unwrap(row.statement_encrypted,`appeal:${id}`).toString('utf8'):null,reasonCode:row.reason_code,policyRef:row.policy_ref};});}
 decideAppeal(staff:StaffPrincipal,id:string,outcome:string,decision:'uphold'|'overturn'){return transaction(this.db,async tx=>{
  await socialLock(tx);const initial=(await tx.query('SELECT user_id FROM safety.appeals WHERE id=$1',[id])).rows[0];if(!initial)throw new ApiError(404,'not-found','Appeal is unavailable.');
  const user=(await tx.query('SELECT status,deletion_requested_at FROM identity.users WHERE id=$1 FOR UPDATE',[initial.user_id])).rows[0];
  const row=(await tx.query('SELECT a.state,a.action_id,e.decided_by_staff,e.action,e.previous_user_status,e.reversed_at FROM safety.appeals a JOIN safety.enforcement_actions e ON e.id=a.action_id WHERE a.id=$1 FOR UPDATE OF a,e',[id])).rows[0];
  if(row.decided_by_staff===staff.id)throw new ApiError(403,'independent-review-required','Another staff member must decide this appeal.');
  if(!['submitted','in_review'].includes(row.state))throw new ApiError(409,'case-final','Appeal is already decided.');
  if(decision==='overturn'){
   if(row.action!=='suspend'||!row.previous_user_status||row.reversed_at||user.status!=='suspended'||user.deletion_requested_at)throw new ApiError(409,'manual-review-required','This action requires a separate account review.');
   const latest=(await tx.query("SELECT id FROM safety.enforcement_actions WHERE subject_type='user' AND subject_id=$1 AND action='suspend' AND reversed_at IS NULL ORDER BY created_at DESC LIMIT 1",[initial.user_id])).rows[0];
   if(latest?.id!==row.action_id)throw new ApiError(409,'manual-review-required','A newer suspension requires review.');
   await tx.query('UPDATE identity.users SET status=$2,updated_at=now() WHERE id=$1',[initial.user_id,row.previous_user_status]);
   await tx.query('UPDATE safety.enforcement_actions SET reversed_at=now(),reversal_reason=$2 WHERE id=$1',[row.action_id,outcome]);
  }
  const state=decision==='overturn'?'overturned':'upheld';await tx.query('UPDATE safety.appeals SET state=$2,outcome=$3,decided_by_staff=$4,decided_at=now() WHERE id=$1',[id,state,outcome,staff.id]);await this.audit(tx,staff,`appeal.${decision}`,'appeal',id);return {id,state};
 });}
 places(staff:StaffPrincipal,limit:number,cursor?:string){return transaction(this.db,async tx=>{const scope='admin:places',after=decodeCursor(cursor,scope);await this.audit(tx,staff,'places.list','place');return page((await tx.query('SELECT id,name,kind,state,metro_id AS "metroId",created_at AS "createdAt" FROM meetup.places WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',[after,limit+1])).rows,limit,scope);});}
 place(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{const row=(await tx.query('SELECT id,name,kind,latitude::float8,longitude::float8,address,state,metro_id AS "metroId",is_fenced AS "isFenced",has_water AS "hasWater" FROM meetup.places WHERE id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Place is unavailable.');await this.audit(tx,staff,'place.read','place',id);return row;});}
 decidePlace(staff:StaffPrincipal,id:string,state:'approved'|'rejected'|'closed'){return transaction(this.db,async tx=>{const row=(await tx.query('UPDATE meetup.places SET state=$2::meetup.place_state,verified_at=CASE WHEN $2=\'approved\' THEN now() ELSE verified_at END,verified_by_staff=$3 WHERE id=$1 RETURNING id,state',[id,state,staff.id])).rows[0];if(!row)throw new ApiError(404,'not-found','Place is unavailable.');await this.audit(tx,staff,`place.${state}`,'place',id);return row;});}
 auditEvents(staff:StaffPrincipal,q:{limit:number;cursor?:string;from?:string;to?:string;actorKind?:string;action?:string;subjectType?:string;subjectId?:string}){return transaction(this.db,async tx=>{
  const end=q.to?new Date(q.to):new Date(),start=q.from?new Date(q.from):new Date(end.getTime()-7*86400000);
  if(end.getTime()>Date.now()+60000||end.getTime()<=start.getTime()||end.getTime()-start.getTime()>31*86400000)throw new ApiError(400,'invalid-audit-window','Choose a past window of at most 31 days.');
  const scope=`audit:${start.toISOString()}:${end.toISOString()}:${q.actorKind??''}:${q.action??''}:${q.subjectType??''}:${q.subjectId??''}`;
  let after:string|null=null;
  if(q.cursor){try{const data=JSON.parse(Buffer.from(q.cursor,'base64url').toString('utf8'));if(!/^[A-Za-z0-9_-]+$/.test(q.cursor)||data.scope!==scope||typeof data.id!=='string'||!/^\d{1,19}$/.test(data.id)||BigInt(data.id)>9223372036854775807n)throw Error();after=data.id;}catch{throw new ApiError(400,'invalid-cursor','The cursor is invalid for this audit window.');}}
  const rows=(await tx.query(`SELECT id::text,actor_kind AS "actorKind",actor_user_id AS "actorUserId",action,subject_type AS "subjectType",subject_id AS "subjectId",request_id AS "requestId",created_at AS "createdAt" FROM ops.audit_log
   WHERE created_at>=$1 AND created_at<$2 AND ($3::text IS NULL OR actor_kind=$3) AND ($4::text IS NULL OR action=$4) AND ($5::text IS NULL OR subject_type=$5) AND ($6::uuid IS NULL OR subject_id=$6) AND ($7::bigint IS NULL OR id<$7)
   ORDER BY id DESC LIMIT $8`,[start,end,q.actorKind??null,q.action??null,q.subjectType??null,q.subjectId??null,after,q.limit+1])).rows;
  await this.audit(tx,staff,'audit.list','audit');
  const items=rows.slice(0,q.limit);return {items,from:start.toISOString(),to:end.toISOString(),nextCursor:rows.length>q.limit?Buffer.from(JSON.stringify({id:items.at(-1)!.id,scope})).toString('base64url'):null};
 });}
 jobs(staff:StaffPrincipal){return transaction(this.db,async tx=>{await this.audit(tx,staff,'jobs.read','jobs');return {push:(await tx.query('SELECT state,count(*)::int count FROM ops.push_jobs GROUP BY state ORDER BY state')).rows,privacy:(await tx.query('SELECT kind,state,count(*)::int count FROM identity.privacy_requests GROUP BY kind,state ORDER BY kind,state')).rows,maintenance:(await tx.query('SELECT run_id AS \"runId\",status,started_at AS \"startedAt\",finished_at AS \"finishedAt\",summary,last_error_code AS \"lastErrorCode\" FROM ops.maintenance_status WHERE singleton')).rows[0]??null};});}
 support(staff:StaffPrincipal,limit:number,cursor?:string){return transaction(this.db,async tx=>{const scope='admin:support',after=decodeCursor(cursor,scope);await this.audit(tx,staff,'support.list','support');return page((await tx.query('SELECT id,category,state,created_at AS "createdAt" FROM safety.support_tickets WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',[after,limit+1])).rows,limit,scope);});}
 supportDetail(staff:StaffPrincipal,id:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{const ticket=(await tx.query('SELECT id,state,category FROM safety.support_tickets WHERE id=$1',[id])).rows[0];if(!ticket)throw new ApiError(404,'not-found','Ticket is unavailable.');await this.audit(tx,staff,'support.read','support',id);const scope=`admin:support:${id}`,after=decodeCursor(cursor,scope),rows=(await tx.query('SELECT id,author_user_id,body_encrypted,created_at FROM safety.support_messages WHERE ticket_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[id,after,limit+1])).rows,result=page(rows,limit,scope);return {ticket,messages:result.items.map(r=>({id:r.id,author:r.author_user_id?'user':'support',body:this.cipherRequired().unwrap(r.body_encrypted,`support:${r.id}`).toString('utf8'),createdAt:r.created_at})),nextCursor:result.nextCursor};});}
 reply(staff:StaffPrincipal,id:string,message:string,resolve:boolean){return transaction(this.db,async tx=>{const ticket=(await tx.query('SELECT state FROM safety.support_tickets WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!ticket)throw new ApiError(404,'not-found','Ticket is unavailable.');if(ticket.state==='resolved')throw new ApiError(409,'ticket-closed','Ticket is resolved.');const messageId=randomUUID();await tx.query('INSERT INTO safety.support_messages(id,ticket_id,body_encrypted) VALUES($1,$2,$3)',[messageId,id,this.cipherRequired().wrap(Buffer.from(message),`support:${messageId}`)]);await tx.query('UPDATE safety.support_tickets SET state=$2,updated_at=now() WHERE id=$1',[id,resolve?'resolved':'in_review']);await this.audit(tx,staff,'support.reply','support',id);return {id:messageId,state:resolve?'resolved':'in_review'};});}
 pushJobs(staff:StaffPrincipal,state:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  const scope=`admin:push:${state}`,after=decodeCursor(cursor,scope);await this.audit(tx,staff,'push.jobs.list','push_job');
  return page((await tx.query(`SELECT notification_id AS id,state,attempts,available_at AS "availableAt",lease_until AS "leaseUntil",CASE WHEN last_error IS NULL THEN NULL WHEN last_error IN('quiet_hours','unsupported_provider','provider_rejected','retries_exhausted','provider_retry','processing_failed','processing_retry') THEN last_error ELSE 'processing_failed' END AS "lastError" FROM ops.push_jobs WHERE state=$1 AND ($2::uuid IS NULL OR notification_id>$2) ORDER BY notification_id LIMIT $3`,[state,after,limit+1])).rows,limit,scope);
 });}

 retryPush(staff:StaffPrincipal,id:string){return transaction(this.db,async tx=>{
  const row=(await tx.query("UPDATE ops.push_jobs SET state='awaiting_provider',attempts=0,last_error=NULL,lease_token=NULL,lease_until=NULL,available_at=now() WHERE notification_id=$1 AND state='dead_letter' RETURNING notification_id AS id,state",[id])).rows[0];
  if(!row)throw new ApiError(409,'push-job-not-retryable','Only an existing dead-letter job can be retried.');await this.audit(tx,staff,'push.retry','notification',id);return row;
 });}

}
