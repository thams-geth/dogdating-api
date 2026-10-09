import { randomUUID } from 'node:crypto';import type { Pool,PoolClient } from 'pg';import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';import { socialLock } from '../../db/social-lock.js';import { ApiError } from '../../middleware/error.js';import { page,decodeCursor } from '../../http/pagination.js';
import { bodyHash,receipt,saveReceipt } from '../../http/idempotency.js';import type { MessageCipher } from '../messages/message-cipher.js';import type { reportInput,ticketInput,appealInput } from './safety.schemas.js';
export class SafetyService {
 constructor(private readonly db:Pool,private readonly cipher?:MessageCipher){}
 private encryption(){if(!this.cipher)throw new ApiError(503,'safety-storage-unavailable','Private case storage is not configured.');return this.cipher;}
 private async limit(tx:PoolClient,userId:string,kind:'reports'|'support_tickets'|'appeals',limit:number){await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);const column=kind==='reports'?'reporter_user_id':'user_id';if((await tx.query(`SELECT count(*)::int n FROM safety.${kind} WHERE ${column}=$1 AND created_at>now()-interval '1 day'`,[userId])).rows[0].n>=limit)throw new ApiError(429,'case-limit','Daily case limit reached.');}
 private async subject(tx:PoolClient,userId:string,type:string,id:string){
  let allowed=false;
  // Historical membership intentionally permits reporting after blocking/unmatching, but not reading the other person's content.
  const history=`SELECT 1 FROM meetup.conversation_members cm JOIN meetup.conversations c ON c.id=cm.conversation_id JOIN meetup.matches m ON m.id=c.match_id WHERE cm.user_id=$1`;
  if(type==='message')allowed=!!(await tx.query('SELECT 1 FROM meetup.messages msg JOIN meetup.conversation_members cm ON cm.conversation_id=msg.conversation_id WHERE msg.message_id=$2 AND cm.user_id=$1',[userId,id])).rowCount;
  if(type==='meetup')allowed=!!(await tx.query('SELECT 1 FROM meetup.meetup_participants WHERE user_id=$1 AND meetup_id=$2',[userId,id])).rowCount;
  if(type==='dog')allowed=!!(await tx.query(`${history} AND $2 IN (m.dog_a_id,m.dog_b_id) UNION ALL SELECT 1 FROM graph.discovery_sessions WHERE user_id=$1 AND $2=ANY(target_ids) AND expires_at>now()`,[userId,id])).rowCount;
  if(type==='media')allowed=!!(await tx.query(`${history} AND EXISTS(SELECT 1 FROM graph.dog_media media WHERE media.id=$2 AND media.dog_id IN(m.dog_a_id,m.dog_b_id))`,[userId,id])).rowCount;
  if(type==='user')allowed=!!(await tx.query(`${history} AND EXISTS(SELECT 1 FROM meetup.conversation_members peer WHERE peer.conversation_id=c.id AND peer.user_id=$2) UNION ALL SELECT 1 FROM graph.discovery_sessions s JOIN graph.dogs d ON d.id=ANY(s.target_ids) WHERE s.user_id=$1 AND d.published_by=$2 AND s.expires_at>now()`,[userId,id])).rowCount;
  if(!allowed)throw new ApiError(404,'not-found','Report subject is unavailable.');
 }
 report(userId:string,input:z.infer<typeof reportInput>,key:string){return transaction(this.db,async tx=>{
  const cipher=this.encryption();await socialLock(tx);await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);
  const hash=bodyHash(input),cached=await receipt(tx,userId,'report',key,hash);if(cached)return cached;await this.limit(tx,userId,'reports',10);await this.subject(tx,userId,input.subjectType,input.subjectId);
  const id=randomUUID();const row=(await tx.query(`INSERT INTO safety.reports(id,reporter_user_id,subject_type,subject_id,category,narrative_encrypted,severity) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,state,created_at AS "createdAt"`,[id,userId,input.subjectType,input.subjectId,input.category,cipher.wrap(Buffer.from(input.details),`report:${id}`),['animal_welfare','unsafe_behavior'].includes(input.category)?2:1])).rows[0];await saveReceipt(tx,userId,'report',key,hash,row);return row;
 });}
 async reportStatus(userId:string,id:string){const row=(await this.db.query('SELECT id,state,created_at AS "createdAt",resolved_at AS "resolvedAt" FROM safety.reports WHERE id=$1 AND reporter_user_id=$2',[id,userId])).rows[0];if(!row)throw new ApiError(404,'not-found','Report is unavailable.');return row;}
 ticket(userId:string,input:z.infer<typeof ticketInput>,key:string){return transaction(this.db,async tx=>{
  const cipher=this.encryption();await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);const hash=bodyHash(input),cached=await receipt(tx,userId,'support',key,hash);if(cached)return cached;await this.limit(tx,userId,'support_tickets',5);
  const row=(await tx.query('INSERT INTO safety.support_tickets(user_id,category) VALUES($1,$2) RETURNING id,category,state,created_at AS "createdAt",updated_at AS "updatedAt"',[userId,input.category])).rows[0],messageId=randomUUID();
  await tx.query('INSERT INTO safety.support_messages(id,ticket_id,author_user_id,body_encrypted) VALUES($1,$2,$3,$4)',[messageId,row.id,userId,cipher.wrap(Buffer.from(input.message),`support:${messageId}`)]);await saveReceipt(tx,userId,'support',key,hash,row);return row;
 });}
 async tickets(userId:string,limit:number,cursor?:string){const scope=`support:${userId}`,after=decodeCursor(cursor,scope);return page((await this.db.query('SELECT id,category,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM safety.support_tickets WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[userId,after,limit+1])).rows,limit,scope);}
 ticketDetail(userId:string,id:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  const cipher=this.encryption(),ticket=(await tx.query('SELECT id,category,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM safety.support_tickets WHERE id=$1 AND user_id=$2',[id,userId])).rows[0];if(!ticket)throw new ApiError(404,'not-found','Ticket is unavailable.');
  const scope=`support-messages:${userId}:${id}`,after=decodeCursor(cursor,scope),rows=(await tx.query('SELECT id,author_user_id,body_encrypted,created_at FROM safety.support_messages WHERE ticket_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[id,after,limit+1])).rows;
  const result=page(rows,limit,scope);return {ticket,messages:result.items.map(r=>({id:r.id,author:r.author_user_id===userId?'you':'support',body:cipher.unwrap(r.body_encrypted,`support:${r.id}`).toString('utf8'),createdAt:r.created_at})),nextCursor:result.nextCursor};
 });}
 reply(userId:string,id:string,message:string,key:string){return transaction(this.db,async tx=>{
  const cipher=this.encryption();await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);const ticket=(await tx.query('SELECT state FROM safety.support_tickets WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,userId])).rows[0];if(!ticket)throw new ApiError(404,'not-found','Ticket is unavailable.');
  const hash=bodyHash({id,message}),cached=await receipt(tx,userId,'support-reply',key,hash);if(cached)return cached;if(ticket.state==='resolved')throw new ApiError(409,'ticket-closed','Create a new ticket for further help.');
  if((await tx.query("SELECT count(*)::int n FROM safety.support_messages WHERE author_user_id=$1 AND created_at>now()-interval '1 day'",[userId])).rows[0].n>=20)throw new ApiError(429,'support-message-limit','Daily support message limit reached.');
  const messageId=randomUUID(),row=(await tx.query('INSERT INTO safety.support_messages(id,ticket_id,author_user_id,body_encrypted) VALUES($1,$2,$3,$4) RETURNING id,created_at AS "createdAt"',[messageId,id,userId,cipher.wrap(Buffer.from(message),`support:${messageId}`)])).rows[0];await tx.query('UPDATE safety.support_tickets SET updated_at=now() WHERE id=$1',[id]);await saveReceipt(tx,userId,'support-reply',key,hash,row);return row;
 });}
 private incidentProjection=`c.id,c.review_id AS "reviewId",r.meetup_id AS "meetupId",c.state,
   c.created_at AS "createdAt",c.first_action_at AS "firstActionAt",c.decided_at AS "decidedAt"`;
 async incidentReviews(userId:string,limit:number,cursor?:string){
  const scope=`incident-reviews:${userId}`,after=decodeCursor(cursor,scope);
  return page((await this.db.query(`SELECT ${this.incidentProjection} FROM safety.meetup_incident_cases c
   JOIN meetup.meetup_reviews r ON r.id=c.review_id WHERE r.reviewer_user_id=$1
   AND ($2::uuid IS NULL OR c.id>$2) ORDER BY c.id LIMIT $3`,[userId,after,limit+1])).rows,limit,scope);
 }
 async incidentReview(userId:string,id:string){
  const row=(await this.db.query(`SELECT ${this.incidentProjection} FROM safety.meetup_incident_cases c
   JOIN meetup.meetup_reviews r ON r.id=c.review_id WHERE c.id=$1 AND r.reviewer_user_id=$2`,[id,userId])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Incident review is unavailable.');return row;
 }
 async notices(userId:string,limit:number,cursor?:string){const scope=`notices:${userId}`,after=decodeCursor(cursor,scope);return page((await this.db.query(`SELECT id,action,reason_code AS "reasonCode",policy_ref AS "policyRef",created_at AS "createdAt",expires_at AS "expiresAt",reversed_at AS "reversedAt" FROM safety.enforcement_actions WHERE subject_type='user' AND subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[userId,after,limit+1])).rows,limit,scope);}
 appeal(userId:string,input:z.infer<typeof appealInput>){return transaction(this.db,async tx=>{
  const cipher=this.encryption();await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);if(!(await tx.query("SELECT 1 FROM safety.enforcement_actions WHERE id=$1 AND subject_type='user' AND subject_id=$2",[input.actionId,userId])).rowCount)throw new ApiError(404,'not-found','Action is unavailable.');
  const existing=(await tx.query('SELECT id,state FROM safety.appeals WHERE user_id=$1 AND action_id=$2',[userId,input.actionId])).rows[0];if(existing)return existing;await this.limit(tx,userId,'appeals',5);const id=randomUUID();return (await tx.query('INSERT INTO safety.appeals(id,action_id,user_id,statement_encrypted) VALUES($1,$2,$3,$4) RETURNING id,state',[id,input.actionId,userId,cipher.wrap(Buffer.from(input.statement),`appeal:${id}`)])).rows[0];
 });}
 async appeals(userId:string,limit:number,cursor?:string){const scope=`appeals:${userId}`,after=decodeCursor(cursor,scope);return page((await this.db.query('SELECT id,action_id AS "actionId",state,outcome,created_at AS "createdAt",decided_at AS "decidedAt" FROM safety.appeals WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3',[userId,after,limit+1])).rows,limit,scope);}
}
