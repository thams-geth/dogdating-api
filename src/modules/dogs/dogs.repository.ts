import type { PoolClient } from 'pg';
import { ApiError } from '../../middleware/error.js';
import { requireHousehold,type HouseholdRole } from '../households/access.js';
export const dogProjection=`d.id,d.household_id AS "householdId",d.name,d.sex,d.size_class AS "sizeClass",
 d.date_of_birth::text AS "dateOfBirth",d.dob_precision AS "dobPrecision",d.neutered,d.neutered_at::text AS "neuteredAt",
 d.weight_g AS "weightG",d.bio,d.status,d.publication_state AS "publicationState",
 d.created_at AS "createdAt",d.updated_at AS "updatedAt"`;
export class DogsRepository {
 async lock(tx:PoolClient,id:string,userId:string,roles?:HouseholdRole[]){
  const row=(await tx.query<{household_id:string}>('SELECT household_id FROM graph.dogs WHERE id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'not-found','Dog not found.');
  await requireHousehold(tx,row.household_id,userId,roles);
  const dog=(await tx.query(`SELECT ${dogProjection} FROM graph.dogs d WHERE d.id=$1 AND d.deleted_at IS NULL`,[id])).rows[0];
  if(!dog)throw new ApiError(404,'not-found','Dog not found.');
  return dog;
 }
 async detail(tx:PoolClient,id:string){
  const dog=(await tx.query(`SELECT ${dogProjection},d.availability_timezone AS "availabilityTimezone" FROM graph.dogs d WHERE d.id=$1`,[id])).rows[0]!;
  const breeds=(await tx.query(`SELECT b.id AS "breedId",b.canonical_name AS name,db.percentage,db.source
   FROM graph.dog_breeds db JOIN graph.breeds b ON b.id=db.breed_id WHERE db.dog_id=$1 ORDER BY b.canonical_name`,[id])).rows;
  const temperament=(await tx.query(`SELECT questionnaire_version AS "questionnaireVersion",energy,play_style AS "playStyle",
   dog_reactivity AS "dogReactivity",human_reactivity AS "humanReactivity",resource_guarding AS "resourceGuarding",
   recall_reliability AS "recallReliability",size_tolerance AS "sizeTolerance",needs_to_know AS "needsToKnow" FROM graph.dog_temperament WHERE dog_id=$1`,[id])).rows[0]??null;
  const preferences=(await tx.query(`SELECT allow_city_only AS "allowCityOnly",max_distance_bucket AS "maxDistanceBucket",size_classes AS "sizeClasses",age_min_months AS "ageMinMonths",
   age_max_months AS "ageMaxMonths",energy_min AS "energyMin",energy_max AS "energyMax",play_styles AS "playStyles",
   min_verification_tier AS "minVerificationTier",parallel_walk_only AS "parallelWalkOnly",accepts_reactive AS "acceptsReactive" FROM graph.match_preferences WHERE dog_id=$1`,[id])).rows[0]??null;
  const windows=(await tx.query(`SELECT day_of_week AS "dayOfWeek",start_min AS "startMin",end_min AS "endMin" FROM graph.dog_availability
   WHERE dog_id=$1 AND day_of_week IS NOT NULL ORDER BY day_of_week,start_min`,[id])).rows;
  const {availabilityTimezone,...profile}=dog;
  return {...profile,breeds,temperament,preferences,availability:{timezone:availabilityTimezone,windows}};
 }
 async invalidate(tx:PoolClient,id:string,identityChanged=false){
  await tx.query("UPDATE graph.dogs SET publication_state='draft',updated_at=now() WHERE id=$1",[id]);
  await tx.query('DELETE FROM graph.dog_availability WHERE dog_id=$1 AND beacon_until IS NOT NULL',[id]);
  if(identityChanged)await tx.query(`UPDATE verify.tiers_granted SET revoked_at=now(),revoked_reason='dog_profile_changed'
    WHERE subject_type='dog' AND subject_id=$1 AND revoked_at IS NULL`,[id]);
 }
}
