import { randomUUID } from 'node:crypto';
import type { fixture } from './fixture.js';
const metro='01920000-0000-7000-8000-0000000e0001';
export async function readyDog(f:ReturnType<typeof fixture>,documents:string[],name='Fixture Dog',energy=3){
  const user=await f.user(),household=await f.household(user.userId),dog=await f.dog(household);
  // Synthetic evidence exists ONLY in this disposable test DB; no production grant path is fabricated.
  await f.database.query("UPDATE identity.users SET status='active',is_adult_verified=true WHERE id=$1",[user.userId]);
  await f.database.query(`INSERT INTO identity.user_preferences(user_id,adult_declared,active_dog_id,discovery_paused) VALUES ($1,true,$2,false)
    ON CONFLICT(user_id) DO UPDATE SET adult_declared=true,active_dog_id=$2,discovery_paused=false`,[user.userId,dog]);
  for(const id of documents)await f.database.query("INSERT INTO identity.consent_events(user_id,document_id,action) VALUES ($1,$2,'accepted')",[user.userId,id]);
  await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier) VALUES ('user',$1,1)",[user.userId]);
  await f.database.query("UPDATE identity.households SET location_source='manual_area',metro_id=$2 WHERE id=$1",[household,metro]);
  await f.database.query("UPDATE graph.dogs SET name=$2,published_by=$3,publication_state='published' WHERE id=$1",[dog,name,user.userId]);
  await f.database.query('INSERT INTO graph.dog_breeds(dog_id,breed_id,percentage) SELECT $1,id,100 FROM graph.breeds ORDER BY id LIMIT 1',[dog]);
  await f.database.query(`INSERT INTO graph.dog_temperament(dog_id,energy,play_style,dog_reactivity,human_reactivity,resource_guarding,recall_reliability,size_tolerance)
    VALUES ($1,$2,ARRAY['fetch']::graph.play_style[],1,1,1,3,ARRAY['medium']::graph.size_class[])`,[dog,energy]);
  await f.database.query('INSERT INTO graph.match_preferences(dog_id,allow_city_only) VALUES ($1,true)',[dog]);
  for(let i=0;i<3;i++)await f.database.query("INSERT INTO graph.dog_media(id,dog_id,kind,storage_key,ordinal,moderation_state) VALUES ($1,$2,'photo','TEST_FIXTURE_ONLY',$3,'approved')",[randomUUID(),dog,i]);
  return {...user,household,dog};
}