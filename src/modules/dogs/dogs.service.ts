import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { decodeCursor,page } from '../../http/pagination.js';
import { requireHousehold } from '../households/access.js';
import { OnboardingRepository } from '../onboarding/onboarding.repository.js';
import { DogsRepository,dogProjection } from './dogs.repository.js';
import { dogFieldsSchema,validDogDates,type createDogSchema,type updateDogSchema,type breedsSchema,type temperamentSchema,type dogPreferencesSchema,type availabilitySchema } from './dogs.schemas.js';
const editors=['owner','co_guardian'] as ('owner'|'co_guardian')[];
export class DogsService {
 private readonly repo=new DogsRepository();private readonly onboarding=new OnboardingRepository();
 constructor(private readonly db:Pool){}
 private editable(dog:Record<string,unknown>){if(dog.status!=='active')throw new ApiError(409,'dog-inactive','This dog profile can no longer be edited.');}
 async create(userId:string,input:z.infer<typeof createDogSchema>){return transaction(this.db,async tx=>{
  await requireHousehold(tx,input.householdId,userId,editors);
  if(!validDogDates(input))throw new ApiError(400,'invalid-dates','Neutering date requires neutered=true and cannot predate birth.');
  const count=(await tx.query("SELECT count(*)::int AS n FROM graph.dogs WHERE household_id=$1 AND status='active' AND deleted_at IS NULL",[input.householdId])).rows[0]!.n;
  if(count>=20)throw new ApiError(409,'dog-limit','At most twenty active dogs per household are supported.');
  const id=randomUUID();await tx.query(`INSERT INTO graph.dogs(id,household_id,name,sex,size_class,date_of_birth,dob_precision,neutered,neutered_at,weight_g,bio)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,input.householdId,input.name,input.sex,input.sizeClass,input.dateOfBirth,input.dobPrecision??'exact',input.neutered,input.neuteredAt,input.weightG,input.bio]);
  return this.repo.detail(tx,id);
 });}
 async list(userId:string,limit:number,cursor?:string){
  const scope=`dogs:${userId}`,after=decodeCursor(cursor,scope);
  const rows=(await this.db.query(`SELECT ${dogProjection} FROM graph.dogs d
    JOIN identity.households h ON h.id=d.household_id JOIN identity.household_members m ON m.household_id=h.id
    WHERE m.user_id=$1 AND m.accepted_at IS NOT NULL AND h.deleted_at IS NULL AND d.deleted_at IS NULL
    AND ($2::uuid IS NULL OR d.id>$2) ORDER BY d.id LIMIT $3`,[userId,after,limit+1])).rows;
  const result=page(rows as ({id:string}&Record<string,unknown>)[],limit,scope);return {dogs:result.items,nextCursor:result.nextCursor};
 }
 detail(userId:string,id:string){return transaction(this.db,async tx=>{await this.repo.lock(tx,id,userId);return this.repo.detail(tx,id);});}
 update(userId:string,id:string,input:z.infer<typeof updateDogSchema>){return transaction(this.db,async tx=>{
  const dog=await this.repo.lock(tx,id,userId,editors);this.editable(dog);
  const merged=dogFieldsSchema.parse(Object.fromEntries(Object.keys(dogFieldsSchema.shape).map(key=>[key,key in input?input[key as keyof typeof input]:dog[key]])));
  if(!validDogDates(merged))throw new ApiError(400,'invalid-dates','Neutering date requires neutered=true and cannot predate birth.');
  await tx.query(`UPDATE graph.dogs SET name=$2,sex=$3,size_class=$4,date_of_birth=$5,dob_precision=$6,
    neutered=$7,neutered_at=$8,weight_g=$9,bio=$10,updated_at=now() WHERE id=$1`,[id,merged.name,merged.sex,merged.sizeClass,merged.dateOfBirth,merged.dobPrecision,merged.neutered,merged.neuteredAt,merged.weightG,merged.bio]);
  const identityChanged=['name','sex','dateOfBirth','dobPrecision'].some(key=>key in input && input[key as keyof typeof input]!==dog[key]);
  await this.repo.invalidate(tx,id,identityChanged);return this.repo.detail(tx,id);
 });}
 breeds(userId:string,id:string,input:z.infer<typeof breedsSchema>){return transaction(this.db,async tx=>{
  this.editable(await this.repo.lock(tx,id,userId,editors));
  const known=await tx.query('SELECT id FROM graph.breeds WHERE id=ANY($1::uuid[])',[input.breeds.map(b=>b.breedId)]);
  if(known.rowCount!==input.breeds.length)throw new ApiError(400,'unknown-breed','One or more breed IDs are unknown.');
  await tx.query('DELETE FROM graph.dog_breeds WHERE dog_id=$1',[id]);
  for(const breed of input.breeds)await tx.query("INSERT INTO graph.dog_breeds(dog_id,breed_id,percentage,source) VALUES ($1,$2,$3,'declared')",[id,breed.breedId,breed.percentage]);
  await this.repo.invalidate(tx,id,true);return this.repo.detail(tx,id);
 });}
 temperament(userId:string,id:string,v:z.infer<typeof temperamentSchema>){return transaction(this.db,async tx=>{
  this.editable(await this.repo.lock(tx,id,userId,editors));
  await tx.query(`INSERT INTO graph.dog_temperament(dog_id,questionnaire_version,energy,play_style,dog_reactivity,human_reactivity,resource_guarding,recall_reliability,size_tolerance,needs_to_know)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(dog_id) DO UPDATE SET questionnaire_version=excluded.questionnaire_version,
   energy=excluded.energy,play_style=excluded.play_style,dog_reactivity=excluded.dog_reactivity,human_reactivity=excluded.human_reactivity,
   resource_guarding=excluded.resource_guarding,recall_reliability=excluded.recall_reliability,size_tolerance=excluded.size_tolerance,needs_to_know=excluded.needs_to_know,updated_at=now()`,
   [id,v.questionnaireVersion,v.energy,v.playStyle,v.dogReactivity,v.humanReactivity,v.resourceGuarding,v.recallReliability,v.sizeTolerance,v.needsToKnow]);
  await this.repo.invalidate(tx,id);return this.repo.detail(tx,id);
 });}
 preferences(userId:string,id:string,v:z.infer<typeof dogPreferencesSchema>){return transaction(this.db,async tx=>{
  this.editable(await this.repo.lock(tx,id,userId,editors));
  await tx.query(`INSERT INTO graph.match_preferences(dog_id,allow_city_only,max_distance_bucket,size_classes,age_min_months,age_max_months,energy_min,energy_max,play_styles,min_verification_tier,parallel_walk_only,accepts_reactive)
   VALUES ($1,$12,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(dog_id) DO UPDATE SET allow_city_only=excluded.allow_city_only,max_distance_bucket=excluded.max_distance_bucket,size_classes=excluded.size_classes,
   age_min_months=excluded.age_min_months,age_max_months=excluded.age_max_months,energy_min=excluded.energy_min,energy_max=excluded.energy_max,play_styles=excluded.play_styles,
   min_verification_tier=excluded.min_verification_tier,parallel_walk_only=excluded.parallel_walk_only,accepts_reactive=excluded.accepts_reactive,updated_at=now()`,
   [id,v.maxDistanceBucket,v.sizeClasses,v.ageMinMonths,v.ageMaxMonths,v.energyMin,v.energyMax,v.playStyles,v.minVerificationTier,v.parallelWalkOnly,v.acceptsReactive,v.allowCityOnly]);
  return this.repo.detail(tx,id);
 });}
 availability(userId:string,id:string,v:z.infer<typeof availabilitySchema>){return transaction(this.db,async tx=>{
  this.editable(await this.repo.lock(tx,id,userId,editors));
  await tx.query('UPDATE graph.dogs SET availability_timezone=$2,updated_at=now() WHERE id=$1',[id,v.timezone]);
  await tx.query('DELETE FROM graph.dog_availability WHERE dog_id=$1 AND day_of_week IS NOT NULL',[id]);
  for(const window of v.windows)await tx.query('INSERT INTO graph.dog_availability(id,dog_id,day_of_week,start_min,end_min) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),id,window.dayOfWeek,window.startMin,window.endMin]);
  return this.repo.detail(tx,id);
 });}
 state(userId:string,id:string,action:'publish'|'pause'|'memorialise'){return transaction(this.db,async tx=>{
  await this.onboarding.lockUser(tx,userId);
  if(action==='publish'){
    const selected=(await tx.query('SELECT active_dog_id FROM identity.user_preferences WHERE user_id=$1',[userId])).rows[0]!.active_dog_id;
    if(selected!==id)throw new ApiError(409,'publication-incomplete','Select this dog before publishing.');
  }
  const dog=await this.repo.lock(tx,id,userId,action==='memorialise'?['owner']:editors);
  if(action==='memorialise' && dog.status==='memorialised')return this.repo.detail(tx,id);
  this.editable(dog);
  if(action==='publish'){
   const progress=await this.onboarding.snapshot(tx,userId);
   if(!progress.ready || progress.activeDogId!==id)throw new ApiError(409,'publication-incomplete','Select this dog and complete the required onboarding steps before publishing.');
  }
  await tx.query(`UPDATE graph.dogs SET published_by=CASE WHEN $2='published' THEN $4::uuid ELSE published_by END,publication_state=$2,status=CASE WHEN $3 THEN 'memorialised'::graph.dog_status ELSE status END,
    memorialised_at=CASE WHEN $3 THEN now() ELSE memorialised_at END,updated_at=now() WHERE id=$1`,[id,action==='publish'?'published':'paused',action==='memorialise',userId]);
  if(action!=='publish')await tx.query('DELETE FROM graph.dog_availability WHERE dog_id=$1 AND beacon_until IS NOT NULL',[id]);
  await tx.query("INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id) VALUES ($1,'user',$2,'dog',$3)",[userId,`dog.${action}`,id]);
  return this.repo.detail(tx,id);
 });}
 beacon(userId:string,id:string,minutes:number|null){return transaction(this.db,async tx=>{
  await this.onboarding.lockUser(tx,userId);
  if(minutes!==null){
    const selected=(await tx.query('SELECT active_dog_id FROM identity.user_preferences WHERE user_id=$1',[userId])).rows[0]!.active_dog_id;
    if(selected!==id)throw new ApiError(409,'beacon-unavailable','Select this dog before starting a beacon.');
  }
  const dog=await this.repo.lock(tx,id,userId,editors);this.editable(dog);
  if(minutes!==null){
   const progress=await this.onboarding.snapshot(tx,userId);
   const paused=(await tx.query('SELECT discovery_paused FROM identity.user_preferences WHERE user_id=$1',[userId])).rows[0]!.discovery_paused;
   if(dog.publicationState!=='published'||!progress.ready||progress.activeDogId!==id||paused)throw new ApiError(409,'beacon-unavailable','Publish this dog and enable discovery after completing onboarding.');
  }
  await tx.query('DELETE FROM graph.dog_availability WHERE dog_id=$1 AND beacon_until IS NOT NULL',[id]);
  if(minutes===null)return {beaconUntil:null};
  const row=(await tx.query(`INSERT INTO graph.dog_availability(id,dog_id,beacon_until) VALUES ($1,$2,now()+$3*interval '1 minute') RETURNING beacon_until AS "beaconUntil"`,[randomUUID(),id,minutes])).rows[0]!;
  return row;
 });}
}
