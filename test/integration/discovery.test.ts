import { readyDog } from '../support/discovery.js';
import { beforeEach,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
import { DiscoveryService } from '../../src/modules/discovery/discovery.service.js';
import { DiscoveryTokens } from '../../src/modules/discovery/discovery.tokens.js';
const secret=randomBytes(48).toString('hex'), f=fixture(undefined,secret),http=request(f.app);
const metro='01920000-0000-7000-8000-0000000e0001';
let documents:string[]=[];
beforeEach(async()=>{await f.setup();documents=[];for(const purpose of ['terms','privacy','community','location'])documents.push(await f.document(purpose));});
after(()=>f.close());
const ready=(name?:string,energy?:number)=>readyDog(f,documents,name,energy);

async function feed(user:{header:string},query:Record<string,unknown>={}){return (await http.get('/v1/feed').set('Authorization',user.header).query(query).expect(200)).body;}
async function profile(a:{header:string;dog:string},card:{id:string;impressionToken:string},status=200){return http.get(`/v1/dogs/${card.id}/profile`).set('Authorization',a.header).query({dogId:a.dog,impressionToken:card.impressionToken}).expect(status);}

test('home reports real progress and live counters; discovery is disabled without explicit configuration',async()=>{
  const user=await f.user();const home=await http.get('/v1/home').set('Authorization',user.header).expect(200);
  assert.equal(home.body.dog,null);assert.equal(home.body.discovery.reason,'select_dog');assert.equal(home.body.onboarding.ready,false);
  assert.deepEqual(home.body.sections.messages,{status:'unavailable',value:null});
  assert.equal((await new DiscoveryService(f.database).home(user.userId)).discovery.reason,'discovery_disabled');
  await http.get('/v1/feed?latitude=12').set('Authorization',user.header).expect(400);
  await http.get('/v1/feed?mode=lineage').set('Authorization',user.header).expect(400);
  await http.get('/v1/home').expect(401);
});

test('eligible city feed ranks compatibility and returns safe metadata, never exact location or raw storage',async()=>{
  const a=await ready('Actor'),b=await ready('Compatible'),c=await ready('Different energy',5);
  const result=await feed(a);assert.deepEqual(result.cards.map((r:{id:string})=>r.id),[b.dog,c.dog]);
  const card=result.cards[0];assert.equal(card.distance,'unknown');assert.equal(card.locationPrecision,'city');assert.equal(card.mediaDelivery,'unavailable');assert.equal(card.photos.length,3);
  for(const field of ['householdId','storage_key','phone','dateOfBirth','cell_coarse','metro_id','anchor_origin'])assert.ok(!JSON.stringify(result).includes(field));
  const detail=await profile(a,card);assert.equal(detail.body.id,b.dog);assert.equal(detail.body.guardian.id,b.userId);
  const home=await http.get('/v1/home').set('Authorization',a.header).expect(200);assert.equal(home.body.discovery.available,true);
});

test('all privacy gates are rechecked for profile reads after a card has been issued',async()=>{
  const a=await ready('Actor'),b=await ready('Target');const card=(await feed(a)).cards[0];
  const cases:[string,unknown[],string,unknown[]][]=[
    ["UPDATE identity.user_preferences SET discovery_paused=true WHERE user_id=$1",[b.userId],"UPDATE identity.user_preferences SET discovery_paused=false WHERE user_id=$1",[b.userId]],
    ["UPDATE identity.users SET status='suspended' WHERE id=$1",[b.userId],"UPDATE identity.users SET status='active' WHERE id=$1",[b.userId]],
    ['UPDATE identity.users SET is_adult_verified=false WHERE id=$1',[b.userId],'UPDATE identity.users SET is_adult_verified=true WHERE id=$1',[b.userId]],
    ["UPDATE verify.tiers_granted SET expires_at=now()-interval '1 second' WHERE subject_id=$1",[b.userId],'UPDATE verify.tiers_granted SET expires_at=NULL WHERE subject_id=$1',[b.userId]],
    ["UPDATE graph.dogs SET publication_state='paused' WHERE id=$1",[b.dog],"UPDATE graph.dogs SET publication_state='published' WHERE id=$1",[b.dog]],
    ['UPDATE graph.dogs SET published_by=NULL WHERE id=$1',[b.dog],'UPDATE graph.dogs SET published_by=$2 WHERE id=$1',[b.dog,b.userId]],
    ["UPDATE graph.dog_media SET moderation_state='pending' WHERE dog_id=$1 AND ordinal=0",[b.dog],"UPDATE graph.dog_media SET moderation_state='approved' WHERE dog_id=$1",[b.dog]],
    ["UPDATE identity.household_members SET role='view_only' WHERE household_id=$1",[b.household],"UPDATE identity.household_members SET role='owner' WHERE household_id=$1",[b.household]],
    ['UPDATE identity.users SET deletion_requested_at=now() WHERE id=$1',[b.userId],'UPDATE identity.users SET deletion_requested_at=NULL WHERE id=$1',[b.userId]],
  ];
  // Last-owner DB trigger prevents demotion: use accepted_at revocation to test membership instead.
  cases[7]=['UPDATE identity.household_members SET accepted_at=NULL WHERE household_id=$1',[b.household],'UPDATE identity.household_members SET accepted_at=now() WHERE household_id=$1',[b.household]];
  for(const [change,args,restore,restoreArgs]of cases){await f.database.query(change,args);await profile(a,card,404);assert.equal((await feed(a)).cards.length,0);await f.database.query(restore,restoreArgs);}
  await http.delete('/v1/me/consents/location').set('Authorization',b.header).expect(204);await profile(a,card,404);
});

test('blocks propagate between all accepted household members in both directions and revoke issued profiles',async()=>{
  const a=await ready('Actor'),b=await ready('Target'),co=await f.user();
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'view_only',now())",[b.household,co.userId]);
  const card=(await feed(a)).cards[0];
  await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:co.userId}).expect(204);
  assert.equal((await feed(a)).cards.length,0);assert.equal((await feed(b)).cards.length,0);await profile(a,card,404);
  await http.delete(`/v1/me/blocks/${co.userId}`).set('Authorization',a.header).expect(204);
  await http.post('/v1/me/blocks').set('Authorization',co.header).send({userId:a.userId}).expect(204);
  assert.equal((await feed(a)).cards.length,0);await profile(a,card,404);
});

test('matching filters apply both ways and city-only discovery requires explicit opt-in',async()=>{
  const a=await ready('Actor'),b=await ready('Target');
  await f.database.query("UPDATE graph.match_preferences SET size_classes=ARRAY['small']::graph.size_class[] WHERE dog_id=$1",[a.dog]);assert.equal((await feed(a)).cards.length,0);
  await f.database.query("UPDATE graph.match_preferences SET size_classes='{}' WHERE dog_id=$1",[a.dog]);
  await f.database.query('UPDATE graph.match_preferences SET energy_max=1 WHERE dog_id=$1',[b.dog]);assert.equal((await feed(a)).cards.length,0);
  await f.database.query('UPDATE graph.match_preferences SET energy_max=NULL WHERE dog_id=$1',[b.dog]);
  await f.database.query('UPDATE graph.dog_temperament SET dog_reactivity=4 WHERE dog_id=$1',[b.dog]);assert.equal((await feed(a)).cards.length,0);
  await f.database.query('UPDATE graph.match_preferences SET accepts_reactive=true,parallel_walk_only=true WHERE dog_id=$1',[a.dog]);assert.equal((await feed(a)).cards.length,1);
  await f.database.query('UPDATE graph.match_preferences SET allow_city_only=false WHERE dog_id=$1',[a.dog]);assert.equal((await feed(a)).emptyReason,'city_discovery_not_enabled');
  const prefs=await http.get(`/v1/dogs/${a.dog}/discovery-preferences`).set('Authorization',a.header).expect(200);
  assert.equal(prefs.body.effective.distanceBucketApplied,false);
});

test('signed pagination is actor-bound, stable and rechecks targets; changed preferences require restart',async()=>{
  const a=await ready('Actor'),b=await ready('Target one'),c=await ready('Target two');
  const first=await feed(a,{limit:1});assert.ok(first.nextCursor);
  const next=await feed(a,{limit:1,cursor:first.nextCursor});assert.notEqual(first.cards[0].id,next.cards[0].id);assert.equal(next.nextCursor,null);
  await http.get('/v1/feed').set('Authorization',b.header).query({cursor:first.nextCursor}).expect(400);
  await http.get('/v1/feed').set('Authorization',a.header).query({cursor:first.nextCursor+'x'}).expect(400);
  await f.database.query("UPDATE graph.dogs SET publication_state='paused' WHERE id=$1",[next.cards[0].id]);
  assert.equal((await feed(a,{cursor:first.nextCursor})).cards.length,0);
  await http.put(`/v1/dogs/${a.dog}/preferences`).set('Authorization',a.header).send({allowCityOnly:true,energyMin:2}).expect(200);
  await http.get('/v1/feed').set('Authorization',a.header).query({cursor:first.nextCursor}).expect(409);
  await f.database.query("UPDATE graph.dogs SET publication_state='published' WHERE id=$1",[next.cards[0].id]);
  const fresh=await feed(a,{limit:1});assert.ok(fresh.nextCursor);
  await http.patch(`/v1/dogs/${a.dog}`).set('Authorization',a.header).send({name:'Updated actor'}).expect(200);
  await http.post(`/v1/dogs/${a.dog}/publish`).set('Authorization',a.header).send({}).expect(200);
  await http.get('/v1/feed').set('Authorization',a.header).query({cursor:fresh.nextCursor}).expect(409);
  assert.ok([b.dog,c.dog].includes(first.cards[0].id));
});

test('impressions cannot be reused by another actor or for another target, and expire',async()=>{
  const a=await ready('Actor'),b=await ready('Target one'),c=await ready('Target two');const card=(await feed(a)).cards.find((r:{id:string})=>r.id===b.dog);
  await profile(c,card,400);
  await http.get(`/v1/dogs/${c.dog}/profile`).set('Authorization',a.header).query({dogId:a.dog,impressionToken:card.impressionToken}).expect(400);
  const expired=new DiscoveryTokens(secret).sign({kind:'impression',userId:a.userId,dogId:a.dog,targetId:b.dog,mode:'pack',exp:1});
  await profile(a,{id:b.dog,impressionToken:expired},410);
  await http.get(`/v1/dogs/${b.dog}/profile`).set('Authorization',a.header).query({dogId:a.dog}).expect(400);
});

test('new accounts, unpublished dogs and mismatched selection cannot bypass eligibility',async()=>{
  const a=await ready('Actor');await ready('Target');
  await f.database.query("UPDATE identity.users SET status='pending' WHERE id=$1",[a.userId]);assert.equal((await feed(a)).emptyReason,'account_not_eligible');
  await f.database.query("UPDATE identity.users SET status='active' WHERE id=$1",[a.userId]);
  await http.post(`/v1/dogs/${a.dog}/pause`).set('Authorization',a.header).send({}).expect(200);assert.equal((await feed(a)).emptyReason,'dog_not_published');
  await http.get('/v1/feed').set('Authorization',a.header).query({dogId:randomUUID()}).expect(409);
});

test('daily distinct exposure budget and hourly feed refresh limit are durable',async()=>{
  const a=await ready('Actor'),b=await ready('Target');
  await f.database.query(`WITH dogs AS (INSERT INTO graph.dogs(id,household_id,name,sex,size_class)
    SELECT gen_random_uuid(),$1,'BUDGET TEST FIXTURE','female','medium' FROM generate_series(1,200) RETURNING id)
    INSERT INTO graph.discovery_profile_reads(user_id,day,dog_id) SELECT $2,(now() AT TIME ZONE 'UTC')::date,id FROM dogs`,[a.household,a.userId]);
  await http.get('/v1/feed').set('Authorization',a.header).expect(429);
  await f.database.query('DELETE FROM graph.discovery_profile_reads WHERE user_id=$1',[a.userId]);
  await f.database.query(`INSERT INTO graph.discovery_sessions(id,user_id,actor_dog_id,context_hash,target_ids)
    SELECT gen_random_uuid(),$1,$2,'TEST_FIXTURE','{}' FROM generate_series(1,60)`,[a.userId,a.dog]);
  await http.get('/v1/feed').set('Authorization',a.header).expect(429);
  assert.ok(b.dog);
});

test('new policy versions revoke target eligibility and empty reasons do not reveal hidden candidates',async()=>{
  const a=await ready('Actor'),b=await ready('Target');const card=(await feed(a)).cards[0];
  const current=await f.document('privacy','new-fixture-version');
  await http.post('/v1/me/consents').set('Authorization',a.header).send({documentId:current}).expect(200);
  assert.equal((await feed(a)).emptyReason,'no_eligible_dogs');await profile(a,card,404);
  const reason=await http.get('/v1/feed/empty-reason').set('Authorization',a.header).expect(200);assert.equal(reason.body.reason,'no_eligible_dogs');
  assert.ok(!JSON.stringify(reason.body).includes(b.dog));
});
