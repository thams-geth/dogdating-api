import { randomUUID } from 'node:crypto';import type { Pool,PoolClient } from 'pg';import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';import { socialLock } from '../../db/social-lock.js';
import { ApiError } from '../../middleware/error.js';import { page,decodeCursor } from '../../http/pagination.js';
import { bodyHash,receipt,saveReceipt } from '../../http/idempotency.js';
import { ConnectionsRepository } from '../connections/connections.repository.js';import { notifyConversation } from '../notifications/notifications.events.js';
import type { MessageCipher } from '../messages/message-cipher.js';
import type { placeSuggestion,proposeInput,respondInput,cancelInput,reviewInput,extendInput,extensionResponseInput } from './meetups.schemas.js';
const placeProjection=`id,name,kind,latitude::float8,longitude::float8,address,metro_id AS "metroId",is_fenced AS "isFenced",has_water AS "hasWater"`;
export class MeetupsService {
 private readonly connections=new ConnectionsRepository();constructor(private readonly db:Pool,private readonly cipher?:MessageCipher){}
 async places(metroId:string,limit:number,cursor?:string){const scope=`places:${metroId}`,after=decodeCursor(cursor,scope);return page((await this.db.query(`SELECT ${placeProjection} FROM meetup.places WHERE metro_id=$1 AND state='approved' AND verified_at IS NOT NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[metroId,after,limit+1])).rows,limit,scope);}
 async place(id:string){const row=(await this.db.query(`SELECT ${placeProjection} FROM meetup.places WHERE id=$1 AND state='approved' AND verified_at IS NOT NULL`,[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Place is unavailable.');return row;}
 suggest(userId:string,input:z.infer<typeof placeSuggestion>){return transaction(this.db,async tx=>{
  await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);
  if(!(await tx.query(`SELECT 1 FROM ops.metros m JOIN identity.users u ON u.country_code=m.country WHERE m.id=$1 AND u.id=$2`,[input.metroId,userId])).rowCount)throw new ApiError(404,'not-found','Area is unavailable.');
  if((await tx.query("SELECT count(*)::int n FROM meetup.places WHERE submitted_by=$1 AND created_at>now()-interval '1 day'",[userId])).rows[0].n>=3)throw new ApiError(429,'place-suggestion-limit','Three suggestions per day are allowed.');
  return (await tx.query(`INSERT INTO meetup.places(id,name,kind,latitude,longitude,address,metro_id,is_fenced,has_water,submitted_by) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,state`,[input.name,input.kind,input.latitude,input.longitude,input.address,input.metroId,input.isFenced,input.hasWater,userId])).rows[0];
 });}
 private window(start:string,end:string){const a=new Date(start).getTime(),b=new Date(end).getTime();if(a<Date.now()+15*60000||a>Date.now()+30*86400000||b-a<15*60000||b-a>4*3600000)throw new ApiError(400,'invalid-meetup-window','Choose 15 minutes to four hours, starting between 15 minutes and 30 days from now.');}
 private async approvedPlace(tx:PoolClient,id:string,matchId:string){if(!(await tx.query(`SELECT 1 FROM meetup.places p JOIN meetup.matches m ON m.id=$2 JOIN graph.dogs a ON a.id=m.dog_a_id JOIN graph.dogs b ON b.id=m.dog_b_id JOIN identity.households ha ON ha.id=a.household_id JOIN identity.households hb ON hb.id=b.household_id WHERE p.id=$1 AND p.state='approved' AND p.verified_at IS NOT NULL AND p.metro_id=ha.metro_id AND p.metro_id=hb.metro_id FOR SHARE OF p`,[id,matchId])).rowCount)throw new ApiError(404,'not-found','Reviewed place is unavailable in the shared city.');}
 private async participant(tx:PoolClient,userId:string,dogId:string){if(!(await tx.query(`SELECT 1 FROM identity.household_members m JOIN graph.dogs d ON d.household_id=m.household_id JOIN identity.users u ON u.id=m.user_id WHERE d.id=$1 AND m.user_id=$2 AND m.accepted_at IS NOT NULL AND m.role IN ('owner','co_guardian') AND u.status='active' AND u.deleted_at IS NULL AND u.deletion_requested_at IS NULL`,[dogId,userId])).rowCount)throw new ApiError(404,'not-found','Participant is unavailable.');}
 private projection(row:Record<string,any>){return {id:row.id,matchId:row.match_id,placeId:row.place_id,kind:row.kind,windowStart:row.window_start,windowEnd:row.window_end,state:row.state,revision:row.revision,proposedBy:row.proposed_by,cancellationReason:row.cancellation_reason};}
 private async access(tx:PoolClient,userId:string,id:string){
  const row=(await tx.query('SELECT * FROM meetup.meetups WHERE id=$1',[id])).rows[0];if(!row)throw new ApiError(404,'not-found','Meetup is unavailable.');
  const match=await this.connections.match(tx,userId,row.match_id);
  const participant=(await tx.query('SELECT * FROM meetup.meetup_participants WHERE meetup_id=$1 AND user_id=$2',[id,userId])).rows[0];if(!participant)throw new ApiError(404,'not-found','Meetup is unavailable.');
  await this.participant(tx,userId,participant.dog_id);
  if(row.state==='proposed'&&new Date(row.window_start).getTime()<=Date.now()){
   await tx.query("UPDATE meetup.meetups SET state='cancelled',cancellation_reason='proposal_expired',revision=revision+1,updated_at=now() WHERE id=$1",[id]);row.state='cancelled';row.cancellation_reason='proposal_expired';row.revision++;
  }
  return {row,match,participant};
 }
 private async event(tx:PoolClient,conversationId:string,meetupId:string){const participants=(await tx.query('SELECT user_id FROM meetup.meetup_participants WHERE meetup_id=$1',[meetupId])).rows.map(r=>r.user_id);await notifyConversation(tx,conversationId,randomUUID(),'meetups',undefined,participants);}
 propose(userId:string,input:z.infer<typeof proposeInput>,key:string){return transaction(this.db,async tx=>{
  await socialLock(tx);const match=await this.connections.match(tx,userId,input.matchId);
  if(![match.dogAId,match.dogBId].includes(input.hostDogId)||input.guestUserId===userId)throw new ApiError(400,'invalid-participants','Choose the two connected dogs and different guardians.');
  await this.participant(tx,userId,input.hostDogId);const guestDog=match.dogAId===input.hostDogId?match.dogBId:match.dogAId;
  await this.connections.match(tx,input.guestUserId,input.matchId);await this.participant(tx,input.guestUserId,guestDog);
  const hash=bodyHash(input),cached=await receipt(tx,userId,'meetup',key,hash);if(cached)return this.projection((await this.access(tx,userId,cached.id)).row);
  this.window(input.windowStart,input.windowEnd);await this.approvedPlace(tx,input.placeId,input.matchId);
  if((await tx.query("SELECT count(*)::int n FROM meetup.meetups WHERE match_id=$1 AND state IN ('proposed','accepted','in_progress') AND window_end>now()",[input.matchId])).rows[0].n>=3)throw new ApiError(409,'meetup-limit','At most three active meetups per connection.');
  const row=(await tx.query(`INSERT INTO meetup.meetups(id,match_id,place_id,kind,window_start,window_end,proposed_by) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING *`,[input.matchId,input.placeId,input.kind,input.windowStart,input.windowEnd,userId])).rows[0];
  await tx.query("INSERT INTO meetup.meetup_participants(meetup_id,dog_id,user_id,rsvp) VALUES($1,$2,$3,'yes'),($1,$4,$5,'pending')",[row.id,input.hostDogId,userId,guestDog,input.guestUserId]);
  await this.event(tx,match.conversationId,row.id);await saveReceipt(tx,userId,'meetup',key,hash,{id:row.id});return this.projection(row);
 });}
 get(userId:string,id:string){return transaction(this.db,async tx=>{await socialLock(tx);const {row}=await this.access(tx,userId,id);const participants=(await tx.query('SELECT dog_id AS "dogId",user_id AS "userId",rsvp,checked_in_at AS "checkedInAt",checked_out_at AS "checkedOutAt" FROM meetup.meetup_participants WHERE meetup_id=$1 ORDER BY dog_id',[id])).rows;return {...this.projection(row),participants,pendingExtension:await this.pendingExtension(tx,id,row)};});}
 list(userId:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  await socialLock(tx);const scope=`meetups:${userId}`,after=decodeCursor(cursor,scope),rows=(await tx.query('SELECT m.id FROM meetup.meetups m JOIN meetup.meetup_participants p ON p.meetup_id=m.id WHERE p.user_id=$1 AND ($2::uuid IS NULL OR m.id>$2) ORDER BY m.id LIMIT $3',[userId,after,limit+1])).rows;
  const result=page(rows,limit,scope),items=[];for(const row of result.items){try{items.push(this.projection((await this.access(tx,userId,row.id)).row));}catch(e){if(!(e instanceof ApiError&&e.status===404))throw e;}}return {items,nextCursor:result.nextCursor};
 });}
 private revision(row:Record<string,any>,revision:number){if(row.revision!==revision)throw new ApiError(409,'revision-conflict','Refresh the meetup before changing it.');}
 respond(userId:string,id:string,input:z.infer<typeof respondInput>){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row,match}=await this.access(tx,userId,id);this.revision(row,input.revision);
  if(row.state!=='proposed'||row.proposed_by===userId)throw new ApiError(409,'invalid-meetup-state','Only the other guardian can respond to a pending proposal.');
  for(const p of (await tx.query('SELECT dog_id,user_id FROM meetup.meetup_participants WHERE meetup_id=$1',[id])).rows)await this.participant(tx,p.user_id,p.dog_id);
  if(input.action==='counter'){this.window(input.windowStart,input.windowEnd);await this.approvedPlace(tx,input.placeId,row.match_id);
   await tx.query('UPDATE meetup.meetups SET place_id=$2,window_start=$3,window_end=$4,proposed_by=$5 WHERE id=$1',[id,input.placeId,input.windowStart,input.windowEnd,userId]);
   await tx.query("UPDATE meetup.meetup_participants SET rsvp=CASE WHEN user_id=$2 THEN 'yes'::meetup.rsvp ELSE 'pending'::meetup.rsvp END WHERE meetup_id=$1",[id,userId]);
  }else{if(input.action==='accept')await this.approvedPlace(tx,row.place_id,row.match_id);await tx.query('UPDATE meetup.meetups SET state=$2 WHERE id=$1',[id,input.action==='accept'?'accepted':'declined']);await tx.query('UPDATE meetup.meetup_participants SET rsvp=$3 WHERE meetup_id=$1 AND user_id=$2',[id,userId,input.action==='accept'?'yes':'no']);}
  const updated=(await tx.query('UPDATE meetup.meetups SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[id])).rows[0];await this.event(tx,match.conversationId,id);return this.projection(updated);
 });}
 cancel(userId:string,id:string,input:z.infer<typeof cancelInput>){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row,match}=await this.access(tx,userId,id);if(row.state==='cancelled')return this.projection(row);this.revision(row,input.revision);
  if(!['proposed','accepted','in_progress'].includes(row.state))throw new ApiError(409,'invalid-meetup-state','This meetup is already finished.');
  const updated=(await tx.query("UPDATE meetup.meetups SET state='cancelled',cancellation_reason=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",[id,input.reason])).rows[0];await this.event(tx,match.conversationId,id);return this.projection(updated);
 });}
 attendance(userId:string,id:string,revision:number,action:'check-in'|'check-out'){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row,participant,match}=await this.access(tx,userId,id);const field=action==='check-in'?'checked_in_at':'checked_out_at';
  if(participant[field])return this.projection(row);this.revision(row,revision);
  if(!['accepted','in_progress'].includes(row.state))throw new ApiError(409,'invalid-meetup-state','Accept the meetup before checking in.');
  if(action==='check-in'){
   if(Date.now()<new Date(row.window_start).getTime()-30*60000||Date.now()>new Date(row.window_end).getTime())throw new ApiError(409,'check-in-window','Check in from 30 minutes before the start until the end.');await this.approvedPlace(tx,row.place_id,row.match_id);
  }else if(!participant.checked_in_at)throw new ApiError(409,'check-in-required','Check in before checking out.');
  await tx.query(`UPDATE meetup.meetup_participants SET ${field}=now() WHERE meetup_id=$1 AND user_id=$2`,[id,userId]);
  const pending=(await tx.query('SELECT count(*)::int n FROM meetup.meetup_participants WHERE meetup_id=$1 AND checked_out_at IS NULL',[id])).rows[0].n;
  const updated=(await tx.query('UPDATE meetup.meetups SET state=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[id,pending?'in_progress':'completed'])).rows[0];await this.event(tx,match.conversationId,id);return this.projection(updated);
 });}
 private async pendingExtension(tx:PoolClient,id:string,row:Record<string,any>){
  await tx.query("UPDATE meetup.extension_requests SET state='expired' WHERE meetup_id=$1 AND state='pending' AND (expires_at<=now() OR base_revision<>$2 OR $3::text NOT IN ('accepted','in_progress'))",[id,row.revision,row.state]);
  return (await tx.query(`SELECT id,requested_by AS "requestedBy",base_revision AS "baseRevision",proposed_end AS "proposedEnd",expires_at AS "expiresAt",state FROM meetup.extension_requests WHERE meetup_id=$1 AND state='pending'`,[id])).rows[0]??null;
 }
 extend(userId:string,id:string,input:z.infer<typeof extendInput>){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row,match}=await this.access(tx,userId,id);this.revision(row,input.revision);
  if(!['accepted','in_progress'].includes(row.state)||new Date(row.window_end).getTime()<=Date.now())throw new ApiError(409,'extension-unavailable','Extend an accepted meetup before its window ends.');
  if(await this.pendingExtension(tx,id,row))throw new ApiError(409,'extension-pending','Respond to the pending extension first.');
  const end=new Date(new Date(row.window_end).getTime()+input.additionalMinutes*60000);
  if(end.getTime()-new Date(row.window_start).getTime()>4*3600000)throw new ApiError(400,'invalid-meetup-window','Total meetup duration cannot exceed four hours.');
  if((await tx.query('SELECT count(*)::int n FROM meetup.extension_requests WHERE meetup_id=$1',[id])).rows[0].n>=10)throw new ApiError(429,'extension-limit','At most ten extension requests per meetup.');
  await this.approvedPlace(tx,row.place_id,row.match_id);
  await tx.query(`INSERT INTO meetup.extension_requests(meetup_id,requested_by,base_revision,proposed_end,expires_at) VALUES($1,$2,$3,$4,LEAST(now()+interval '15 minutes',$5::timestamptz))`,[id,userId,row.revision,end,row.window_end]);
  await this.event(tx,match.conversationId,id);return (await this.pendingExtension(tx,id,row))!;
 });}
 respondExtension(userId:string,id:string,extensionId:string,input:z.infer<typeof extensionResponseInput>){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row,match}=await this.access(tx,userId,id);
  const extension=(await tx.query('SELECT * FROM meetup.extension_requests WHERE id=$1 AND meetup_id=$2',[extensionId,id])).rows[0];
  if(!extension)throw new ApiError(404,'not-found','Extension is unavailable.');
  if(extension.requested_by===userId)throw new ApiError(409,'extension-responder-required','The other participant must respond.');
  if(extension.state===(input.accept?'accepted':'declined'))return this.projection(row);
  this.revision(row,input.revision);
  if(extension.state!=='pending'||extension.base_revision!==row.revision||new Date(extension.expires_at).getTime()<=Date.now()||!['accepted','in_progress'].includes(row.state))throw new ApiError(409,'extension-unavailable','Extension expired or meetup changed; refresh the meetup.');
  if(input.accept){
   for(const p of (await tx.query('SELECT dog_id,user_id FROM meetup.meetup_participants WHERE meetup_id=$1',[id])).rows)await this.participant(tx,p.user_id,p.dog_id);
   await this.approvedPlace(tx,row.place_id,row.match_id);
   await tx.query('UPDATE meetup.meetups SET window_end=$2,revision=revision+1,updated_at=now() WHERE id=$1',[id,extension.proposed_end]);
  }
  await tx.query('UPDATE meetup.extension_requests SET state=$2 WHERE id=$1',[extensionId,input.accept?'accepted':'declined']);
  await this.event(tx,match.conversationId,id);return this.projection((await tx.query('SELECT * FROM meetup.meetups WHERE id=$1',[id])).rows[0]);
 });}
 review(userId:string,id:string,input:z.infer<typeof reviewInput>){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row}=await this.access(tx,userId,id);
  if(!['accepted','in_progress','completed','no_show'].includes(row.state)||new Date(row.window_end).getTime()>Date.now())throw new ApiError(409,'review-unavailable','Review after the accepted meetup window ends.');
  const subject=(await tx.query('SELECT dog_id FROM meetup.meetup_participants WHERE meetup_id=$1 AND user_id<>$2',[id,userId])).rows[0];
  const existing=(await tx.query('SELECT id FROM meetup.meetup_reviews WHERE meetup_id=$1 AND reviewer_user_id=$2',[id,userId])).rows[0];if(existing)throw new ApiError(409,'review-exists','One review per participant is allowed.');
  if(input.privateNote&&!this.cipher)throw new ApiError(503,'private-note-unavailable','Private note encryption is not configured.');const reviewId=randomUUID();
  await tx.query(`INSERT INTO meetup.meetup_reviews(id,meetup_id,reviewer_user_id,subject_dog_id,showed_up,on_time,dog_as_described,human_respectful,play_compatibility,would_repeat,incident_occurred,incident_type,private_note_encrypted,public_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[reviewId,id,userId,subject.dog_id,input.showedUp,input.onTime,input.dogAsDescribed,input.humanRespectful,input.playCompatibility,input.wouldRepeat,input.incidentOccurred,input.incidentType,input.privateNote?this.cipher!.wrap(Buffer.from(input.privateNote),`review:${reviewId}`):null,input.publicNote]);
  return {id:reviewId,safetyReviewStatus:input.incidentOccurred||input.privateNote?'awaiting_review':'not_requested'};
 });}
 reviews(userId:string,id:string){return transaction(this.db,async tx=>{
  await socialLock(tx);const {row}=await this.access(tx,userId,id);const rows=(await tx.query(`SELECT id,reviewer_user_id AS "reviewerUserId",subject_dog_id AS "subjectDogId",showed_up AS "showedUp",on_time AS "onTime",dog_as_described AS "dogAsDescribed",human_respectful AS "humanRespectful",play_compatibility AS "playCompatibility",would_repeat AS "wouldRepeat",public_note AS "publicNote",created_at AS "createdAt" FROM meetup.meetup_reviews WHERE meetup_id=$1 ORDER BY created_at`,[id])).rows;
  const released=rows.length>=2||Date.now()>=new Date(row.window_end).getTime()+7*86400000;return {released,reviews:released?rows:rows.filter(r=>r.reviewerUserId===userId)};
 });}
}
