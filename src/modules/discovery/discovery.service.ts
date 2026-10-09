import { homeSummary } from './home-summary.js';
import { socialLock } from '../../db/social-lock.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { OnboardingRepository } from '../onboarding/onboarding.repository.js';
import { DogsRepository } from '../dogs/dogs.repository.js';
import { dogPreferencesSchema } from '../dogs/dogs.schemas.js';
import { DiscoveryRepository } from './discovery.repository.js';
import { DiscoveryTokens } from './discovery.tokens.js';
import type { feedQuery } from './discovery.schemas.js';
export class DiscoveryService {
  private readonly onboarding=new OnboardingRepository();private readonly dogs=new DogsRepository();private readonly repo=new DiscoveryRepository();
  private readonly tokens?:DiscoveryTokens;
  constructor(private readonly db:Pool, secret?:string,private readonly messagesAvailable=false){if(secret)this.tokens=new DiscoveryTokens(secret);}
  async actor(tx:PoolClient,userId:string,dogId?:string){
    await this.onboarding.lockUser(tx,userId);
    const preference=(await tx.query('SELECT active_dog_id,discovery_paused FROM identity.user_preferences WHERE user_id=$1',[userId])).rows[0]!;
    if(dogId&&dogId!==preference.active_dog_id)throw new ApiError(409,'active-dog-required','Select this dog before using discovery.');
    const progress=await this.onboarding.snapshot(tx,userId);
    const id=progress.activeDogId;
    const dog=id?await this.dogs.lock(tx,id,userId):null;
    const context=id?(await tx.query(`SELECT d.updated_at AS dog_updated_at,h.updated_at AS household_updated,p.* FROM graph.dogs d
      JOIN identity.households h ON h.id=d.household_id LEFT JOIN graph.match_preferences p ON p.dog_id=d.id WHERE d.id=$1`,[id])).rows[0]:null;
    const eligibleUser=!!(await tx.query('SELECT id FROM graph.discovery_guardians WHERE id=$1',[userId])).rowCount;
    const eligibleDog=id?!!(await tx.query(`SELECT d.id FROM graph.discovery_dogs d JOIN identity.household_members m ON m.household_id=d.household_id
      WHERE d.id=$1 AND m.user_id=$2 AND m.accepted_at IS NOT NULL AND m.role IN ('owner','co_guardian')`,[id,userId])).rowCount:false;
    const reason=!this.tokens?'discovery_disabled':!id?'select_dog':!progress.ready?'onboarding_incomplete'
      :preference.discovery_paused?'discovery_paused':!eligibleUser?'account_not_eligible'
      :dog?.publicationState!=='published'?'dog_not_published':!context?.allow_city_only?'city_discovery_not_enabled'
      :!eligibleDog?'dog_not_eligible':null;
    return {id,dog,progress,reason,contextHash:createHash('sha256').update(JSON.stringify(context)).digest('hex')};
  }
  home(userId:string,dogId?:string){return transaction(this.db,async tx=>{
    await socialLock(tx);
    const actor=await this.actor(tx,userId,dogId);
    return {dog:actor.dog?{id:actor.dog.id,name:actor.dog.name,publicationState:actor.dog.publicationState}:null,
      onboarding:actor.progress,discovery:{available:actor.reason===null,reason:actor.reason,scope:'city',distance:'unknown',mediaDelivery:'unavailable'},
      sections:await homeSummary(tx,userId,this.messagesAvailable)};
  });}
  private async budget(tx:PoolClient,userId:string,ids:string[]){
    const rows=(await tx.query("SELECT dog_id FROM graph.discovery_profile_reads WHERE user_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date",[userId])).rows;
    const known=new Set(rows.map(r=>r.dog_id));const fresh=[...new Set(ids)].filter(id=>!known.has(id));
    if(known.size+fresh.length>200)throw new ApiError(429,'discovery-limit','The daily discovery limit is reached; try after midnight UTC.');
    for(const id of fresh)await tx.query("INSERT INTO graph.discovery_profile_reads(user_id,day,dog_id) VALUES ($1,(now() AT TIME ZONE 'UTC')::date,$2) ON CONFLICT DO NOTHING",[userId,id]);
  }
  private card(row:Record<string,any>){
    return {id:row.id,name:row.name,sex:row.sex,sizeClass:row.sizeClass,ageMonths:row.ageMonths,bio:row.bio,
      temperament:{energy:row.energy,playStyle:row.playStyle,dogReactivity:row.dogReactivity,humanReactivity:row.humanReactivity},
      verificationTier:row.verificationTier,guardian:{id:row.guardianId,displayName:row.guardianName},
      distance:'unknown',locationPrecision:'city',photos:row.photos,mediaDelivery:'unavailable'};
  }
  feed(userId:string,input:z.infer<typeof feedQuery>){return transaction(this.db,async tx=>{
    const actor=await this.actor(tx,userId,input.dogId);
    if(actor.reason)return {cards:[],nextCursor:null,emptyReason:actor.reason,missing:actor.progress.missing,scope:'city'};
    let session:{id:string;target_ids:string[];expires_at:Date;context_hash:string},offset=0;
    if(input.cursor){
      const token=this.tokens!.verify(input.cursor);
      if(token.kind!=='cursor'||token.userId!==userId||token.dogId!==actor.id)throw new ApiError(400,'invalid-discovery-token','Cursor does not belong to this actor.');
      const row=(await tx.query('SELECT id,target_ids,expires_at,context_hash FROM graph.discovery_sessions WHERE id=$1 AND user_id=$2 AND actor_dog_id=$3',[token.sessionId,userId,actor.id])).rows[0];
      if(!row||row.expires_at<=new Date())throw new ApiError(410,'discovery-token-expired','Feed expired; restart the feed.');
      if(row.context_hash!==actor.contextHash)throw new ApiError(409,'discovery-context-changed','Your discovery settings changed; restart the feed.');
      session=row;offset=token.offset;
    }else{
      const count=(await tx.query("SELECT count(*)::int AS n FROM graph.discovery_sessions WHERE user_id=$1 AND created_at>now()-interval '1 hour'",[userId])).rows[0]!.n;
      if(count>=60)throw new ApiError(429,'feed-refresh-limit','Too many feed refreshes; try again later.');
      const ranked=await this.repo.ranked(tx,actor.id!,userId);
      session=(await tx.query(`INSERT INTO graph.discovery_sessions(id,user_id,actor_dog_id,context_hash,target_ids)
        VALUES ($1,$2,$3,$4,$5) RETURNING id,target_ids,expires_at,context_hash`,[randomUUID(),userId,actor.id,actor.contextHash,ranked.map(r=>r.id)])).rows[0];
    }
    const rows=await this.repo.cards(tx,actor.id!,userId,session.target_ids,offset,input.limit+1);
    const served=rows.slice(0,input.limit);await this.budget(tx,userId,served.map(r=>r.id));
    const exp=Math.floor(session.expires_at.getTime()/1000);
    const cards=served.map(row=>({...this.card(row),impressionToken:this.tokens!.sign({kind:'impression',userId,dogId:actor.id!,targetId:row.id,mode:'pack',exp})}));
    const nextCursor=rows.length>input.limit?this.tokens!.sign({kind:'cursor',userId,dogId:actor.id!,sessionId:session.id,offset:served.at(-1)!.position+1,exp}):null;
    return {cards,nextCursor,emptyReason:cards.length?null:input.cursor?'end_of_feed':'no_eligible_dogs',missing:[],scope:'city'};
  });}
  emptyReason(userId:string,dogId?:string){return transaction(this.db,async tx=>{
    const actor=await this.actor(tx,userId,dogId);
    return {reason:actor.reason??((await this.repo.ranked(tx,actor.id!,userId)).length?null:'no_eligible_dogs'),missing:actor.progress.missing,scope:'city'};
  });}
  profile(userId:string,targetId:string,dogId:string,impressionToken:string){return transaction(this.db,async tx=>{
    const actor=await this.actor(tx,userId,dogId);
    if(actor.reason)throw new ApiError(409,'discovery-ineligible','Discovery is unavailable; refresh home for the current reason.');
    const token=this.tokens!.verify(impressionToken);
    if(token.kind!=='impression'||token.userId!==userId||token.dogId!==dogId||token.targetId!==targetId)throw new ApiError(400,'invalid-discovery-token','Impression does not belong to this actor and target.');
    const row=(await this.repo.cards(tx,dogId,userId,[targetId],0,1))[0];
    if(!row)throw new ApiError(404,'not-found','Discovery profile is unavailable.');
    await this.budget(tx,userId,[targetId]);return this.card(row);
  });}
  preferences(userId:string,dogId:string){return transaction(this.db,async tx=>{
    await this.dogs.lock(tx,dogId,userId,['owner','co_guardian']);const detail=await this.dogs.detail(tx,dogId);
    return {preferences:detail.preferences??dogPreferencesSchema.parse({}),effective:{scope:'city',distance:'unknown',distanceBucketApplied:false},
      limits:{pageSize:50,snapshotSize:200,distinctDogsPerDay:200,refreshesPerHour:60,tokenLifetimeSeconds:600},mode:'pack'};
  });}
}
