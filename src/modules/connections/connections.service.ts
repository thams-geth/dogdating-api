import { notifyConversation } from '../notifications/notifications.events.js';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { socialLock } from '../../db/social-lock.js';
import { ApiError } from '../../middleware/error.js';
import { bodyHash, receipt, saveReceipt } from '../../http/idempotency.js';
import { decodeCursor, page } from '../../http/pagination.js';
import { DiscoveryService } from '../discovery/discovery.service.js';
import { DiscoveryRepository } from '../discovery/discovery.repository.js';
import { DiscoveryTokens } from '../discovery/discovery.tokens.js';
import { DogsRepository } from '../dogs/dogs.repository.js';
import { ConnectionsRepository } from './connections.repository.js';
import type { decisionSchema } from './connections.schemas.js';
export class ConnectionsService {
 private readonly discovery:DiscoveryService; private readonly tokens?:DiscoveryTokens;
 private readonly candidates=new DiscoveryRepository(); private readonly repo=new ConnectionsRepository(); private readonly dogs=new DogsRepository();
 constructor(private readonly db:Pool,secret?:string){this.discovery=new DiscoveryService(db,secret);if(secret)this.tokens=new DiscoveryTokens(secret);}
 private async eligible(tx:PoolClient,userId:string,actorId:string,targetId:string){
  const actor=await this.discovery.actor(tx,userId,actorId);
  if(actor.reason)throw new ApiError(409,'discovery-ineligible','Discovery is unavailable; refresh home.');
  if(!(await this.candidates.cards(tx,actorId,userId,[targetId],0,1,true)).length)throw new ApiError(404,'not-found','Dog is unavailable.');
 }
 private async allowance(tx:PoolClient,userId:string){
  const row=(await tx.query(`SELECT coalesce((SELECT used FROM meetup.interest_usage WHERE user_id=$1 AND day=(now() AT TIME ZONE 'Asia/Kolkata')::date),0)::int AS used,
   (((now() AT TIME ZONE 'Asia/Kolkata')::date+1)::timestamp AT TIME ZONE 'Asia/Kolkata') AS "resetsAt"`,[userId])).rows[0];
  return {plan:'free',dailyInterests:12,remaining:12-row.used,resetsAt:row.resetsAt,timeZone:'Asia/Kolkata',purchasesAvailable:false};
 }
 entitlements(userId:string){return transaction(this.db,tx=>this.allowance(tx,userId));}
 decide(userId:string,input:z.infer<typeof decisionSchema>,key:string){return transaction(this.db,async tx=>{
  await socialLock(tx);
  await tx.query('SELECT id FROM identity.users WHERE id=$1 FOR UPDATE',[userId]);
  // Stable household ordering also coordinates with membership/profile changes.
  await tx.query(`SELECT id FROM identity.households WHERE id IN (SELECT household_id FROM graph.dogs WHERE id=ANY($1::uuid[])) ORDER BY id FOR UPDATE`,[[input.actorDogId,input.targetDogId]]);
  await this.eligible(tx,userId,input.actorDogId,input.targetDogId);
  const hash=bodyHash(input),cached=await receipt(tx,userId,'decision',key,hash);
  if(cached){if(cached.matchId)await this.repo.match(tx,userId,cached.matchId);return cached;}
  const token=this.tokens!.verify(input.impressionToken);
  if(token.kind!=='impression'||token.userId!==userId||token.dogId!==input.actorDogId||token.targetId!==input.targetDogId)throw new ApiError(400,'invalid-discovery-token','Impression does not belong to this decision.');
  const pair=[input.actorDogId,input.targetDogId].sort();
  const existingMatch=(await tx.query('SELECT id,state FROM meetup.matches WHERE dog_a_id=$1 AND dog_b_id=$2 AND mode=$3',[...pair,'pack'])).rows[0];
  if(existingMatch&&existingMatch.state!=='active')throw new ApiError(409,'connection-ended','This connection cannot be restored.');
  await tx.query("DELETE FROM meetup.decisions WHERE actor_dog_id=$1 AND target_dog_id=$2 AND mode='pack' AND verdict='pass' AND decided_at<now()-interval '180 days'",[input.actorDogId,input.targetDogId]);
  let decision=(await tx.query('SELECT id,verdict,withdrawn_at FROM meetup.decisions WHERE actor_dog_id=$1 AND target_dog_id=$2 AND mode=$3',[input.actorDogId,input.targetDogId,'pack'])).rows[0];
  if(decision&&(decision.verdict!==input.verdict||decision.withdrawn_at))throw new ApiError(409,'decision-conflict','A decision already exists for this pair.');
  if(!decision){
   if(input.verdict==='interest'){
    if((await this.allowance(tx,userId)).remaining===0)throw new ApiError(429,'interest-limit','Daily interest limit reached.');
    await tx.query(`INSERT INTO meetup.interest_usage(user_id,day,used) VALUES($1,(now() AT TIME ZONE 'Asia/Kolkata')::date,1) ON CONFLICT(user_id,day) DO UPDATE SET used=meetup.interest_usage.used+1`,[userId]);
   }
   decision=(await tx.query(`INSERT INTO meetup.decisions(actor_dog_id,target_dog_id,mode,verdict,requested_by) VALUES($1,$2,'pack',$3,$4) RETURNING id,verdict`,[input.actorDogId,input.targetDogId,input.verdict,userId])).rows[0];
  }
  let matchId=existingMatch?.id??null;
  if(input.verdict==='interest'&&!matchId&&(await tx.query(`SELECT 1 FROM meetup.decisions WHERE actor_dog_id=$1 AND target_dog_id=$2 AND mode='pack' AND verdict='interest' AND withdrawn_at IS NULL`,[input.targetDogId,input.actorDogId])).rowCount){
   matchId=(await tx.query(`INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES(gen_random_uuid(),$1,$2,$3,'pack') RETURNING id`,[pair.join(':'),...pair])).rows[0].id;
   const conversation=(await tx.query('INSERT INTO meetup.conversations(id,match_id) VALUES(gen_random_uuid(),$1) RETURNING id',[matchId])).rows[0].id;
   await tx.query(`INSERT INTO meetup.conversation_members(conversation_id,user_id) SELECT DISTINCT $1::uuid,m.user_id FROM identity.household_members m JOIN graph.dogs d ON d.household_id=m.household_id WHERE d.id=ANY($2::uuid[]) AND m.accepted_at IS NOT NULL AND m.role IN ('owner','co_guardian')`,[conversation,pair]);
   await notifyConversation(tx,conversation,matchId,'connections');
  }
  const result={id:decision.id,verdict:decision.verdict,matchId};
  await saveReceipt(tx,userId,'decision',key,hash,result);return result;
 });}
 likes(userId:string,dogId:string,direction:'sent'|'received',limit:number,cursor?:string){return transaction(this.db,async tx=>{
  const actor=await this.discovery.actor(tx,userId,dogId);
  if(actor.reason)throw new ApiError(409,'discovery-ineligible','Discovery is unavailable; refresh home.');
  const scope=`likes:${direction}:${userId}:${dogId}`,after=decodeCursor(cursor,scope);
  const own=direction==='sent'?'actor_dog_id':'target_dog_id',other=direction==='sent'?'target_dog_id':'actor_dog_id';
  const rows=(await tx.query(`SELECT id,${other} AS "dogId",decided_at AS "createdAt" FROM meetup.decisions d WHERE ${own}=$1 AND mode='pack' AND verdict='interest' AND withdrawn_at IS NULL AND ($2::uuid IS NULL OR id>$2) AND NOT EXISTS(SELECT 1 FROM meetup.matches m WHERE m.mode='pack' AND m.dog_a_id=least(d.actor_dog_id,d.target_dog_id) AND m.dog_b_id=greatest(d.actor_dog_id,d.target_dog_id)) ORDER BY id LIMIT $3`,[dogId,after,limit+1])).rows;
  const result=page(rows,limit,scope),items=[];
  for(const row of result.items){
   const card=(await this.candidates.cards(tx,dogId,userId,[row.dogId],0,1,true))[0];
   if(card)items.push({...row,dog:{id:card.id,name:card.name},impressionToken:this.tokens!.sign({kind:'impression',userId,dogId,targetId:card.id,mode:'pack',exp:Math.floor(Date.now()/1000)+600})});
  }
  return {items,nextCursor:result.nextCursor};
 });}
 withdraw(userId:string,id:string){return transaction(this.db,async tx=>{
  await socialLock(tx);
  const row=(await tx.query("SELECT actor_dog_id,target_dog_id FROM meetup.decisions WHERE id=$1 AND verdict='interest'",[id])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Like is unavailable.');
  await this.dogs.lock(tx,row.actor_dog_id,userId,['owner','co_guardian']);
  if((await tx.query(`SELECT 1 FROM meetup.matches WHERE dog_a_id=least($1::uuid,$2::uuid) AND dog_b_id=greatest($1::uuid,$2::uuid) AND mode='pack'`,[row.actor_dog_id,row.target_dog_id])).rowCount)throw new ApiError(409,'already-connected','End the connection instead.');
  await tx.query('UPDATE meetup.decisions SET withdrawn_at=coalesce(withdrawn_at,now()) WHERE id=$1',[id]);
 });}
 matches(userId:string,limit:number,cursor?:string){return transaction(this.db,async tx=>{
  await socialLock(tx);
  const scope=`matches:${userId}`,after=decodeCursor(cursor,scope);
  const rows=(await tx.query(`SELECT m.id FROM meetup.matches m JOIN meetup.conversations c ON c.match_id=m.id JOIN meetup.conversation_members cm ON cm.conversation_id=c.id WHERE cm.user_id=$1 AND m.state='active' AND ($2::uuid IS NULL OR m.id>$2) ORDER BY m.id LIMIT $3`,[userId,after,limit+1])).rows;
  const result=page(rows,limit,scope),items=[];
  for(const row of result.items){try{items.push(this.repo.projection(await this.repo.match(tx,userId,row.id)));}catch(error){if(!(error instanceof ApiError&&error.status===404))throw error;}}
  return {items,nextCursor:result.nextCursor};
 });}
 match(userId:string,id:string){return transaction(this.db,async tx=>{await socialLock(tx);return this.repo.projection(await this.repo.match(tx,userId,id));});}
 unmatch(userId:string,id:string){return transaction(this.db,async tx=>{
  await socialLock(tx);await this.repo.match(tx,userId,id,true);
  await tx.query("UPDATE meetup.matches SET state='ended',ended_at=now(),ended_by=$2,end_reason='unmatch' WHERE id=$1 AND state='active'",[id,userId]);
  await tx.query("UPDATE meetup.conversations SET state='closed' WHERE match_id=$1",[id]);
 });}
}
