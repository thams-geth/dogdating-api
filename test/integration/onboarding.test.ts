import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../support/fixture.js';
const f=fixture();before(()=>f.setup());after(()=>f.close());
const state=(header:string)=>request(f.app).get('/v1/me/onboarding').set('Authorization',header);

test('onboarding resumes persisted declaration; does not manufacture verification or legal documents',async()=>{
  const user=await f.user();
  const initial=await state(user.header).expect(200);
  assert.ok(initial.body.missing.includes('terms-document-unavailable'));
  const saved=await request(f.app).put('/v1/me/onboarding/preferences').set('Authorization',user.header)
    .send({countryCode:'IN',locale:'en-IN',mode:'pack',adultDeclared:true}).expect(200);
  assert.equal(saved.body.preferences.adultDeclared,true);
  const resumed=await state(user.header).expect(200);assert.equal(resumed.body.preferences.adultDeclared,true);
  assert.ok(resumed.body.missing.includes('guardian-verification'));
  const row=(await f.database.query('SELECT is_adult_verified FROM identity.users WHERE id=$1',[user.userId])).rows[0];
  assert.equal(row.is_adult_verified,false);
});

test('only current published country/locale policy can be accepted; published contents are immutable',async()=>{
  const user=await f.user();const draft=await f.document('terms','draft',false);
  await request(f.app).get('/v1/legal/documents/terms').expect(404);
  await request(f.app).post('/v1/me/consents').set('Authorization',user.header).send({documentId:draft}).expect(409);
  const published=await f.document('terms');
  const doc=await request(f.app).get('/v1/legal/documents/terms?countryCode=IN&locale=en-IN').expect(200);
  assert.equal(doc.body.id,published);assert.equal(doc.body.contentSha256.length,64);
  await assert.rejects(f.database.query("UPDATE identity.policy_documents SET body='changed' WHERE id=$1",[published]),{code:'23514'});
  await Promise.all([1,2,3].map(()=>request(f.app).post('/v1/me/consents').set('Authorization',user.header).send({documentId:published}).expect(200)));
  const events=(await f.database.query('SELECT count(*)::int AS n FROM identity.consent_events WHERE user_id=$1',[user.userId])).rows[0];assert.equal(events.n,1);
  await f.document('terms','test-v2');
  await request(f.app).post('/v1/me/consents').set('Authorization',user.header).send({documentId:published}).expect(409);
  const current=await request(f.app).get('/v1/me/consents').set('Authorization',user.header).expect(200);
  assert.equal(current.body.consents.find((c:any)=>c.purpose==='terms').current,false);
  await request(f.app).get('/v1/legal/documents/terms?version=test-v1').expect(200);
});

test('withdrawal appends evidence and pauses discovery without affecting another guardian',async()=>{
  const a=await f.user();const b=await f.user();const doc=await f.document('privacy');
  for(const user of [a,b]) await request(f.app).post('/v1/me/consents').set('Authorization',user.header).send({documentId:doc}).expect(200);
  await f.database.query('UPDATE identity.user_preferences SET discovery_paused=false WHERE user_id=$1',[a.userId]);
  for(const repeat of [1,2]) await request(f.app).delete('/v1/me/consents/privacy').set('Authorization',a.header).expect(204);
  const events=(await f.database.query('SELECT action FROM identity.consent_events WHERE user_id=$1 ORDER BY id',[a.userId])).rows;
  assert.deepEqual(events.map(e=>e.action),['accepted','withdrawn']);
  const pref=await request(f.app).get('/v1/me/preferences').set('Authorization',a.header).expect(200);assert.equal(pref.body.discoveryPaused,true);
  const other=await request(f.app).get('/v1/me/consents').set('Authorization',b.header).expect(200);assert.equal(other.body.consents.find((c:any)=>c.purpose==='privacy').current,true);
});

test('active dog selection is ownership-scoped and removed membership is rechecked on progress',async()=>{
  const a=await f.user();const b=await f.user();const h=await f.household(a.userId);const dog=await f.dog(h);
  await request(f.app).put('/v1/me/active-dog').set('Authorization',b.header).send({dogId:dog}).expect(404);
  await request(f.app).put('/v1/me/active-dog').set('Authorization',a.header).send({dogId:dog}).expect(200);
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'co_guardian',now())",[h,b.userId]);
  await request(f.app).put('/v1/me/active-dog').set('Authorization',b.header).send({dogId:dog}).expect(200);
  await f.database.query('DELETE FROM identity.household_members WHERE household_id=$1 AND user_id=$2',[h,b.userId]);
  const progress=await state(b.header).expect(200);assert.equal(progress.body.activeDogId,null);
});

test('completion cannot be forged and incomplete accounts cannot enable discovery',async()=>{
  const user=await f.user();
  await request(f.app).post('/v1/me/onboarding/complete').set('Authorization',user.header).send({completed:true}).expect(400);
  await request(f.app).post('/v1/me/onboarding/complete').set('Authorization',user.header).send({}).expect(409);
  await request(f.app).patch('/v1/me/preferences').set('Authorization',user.header).send({discoveryPaused:false}).expect(409);
  await request(f.app).put('/v1/me/onboarding/preferences').set('Authorization',user.header)
    .send({countryCode:'IN',locale:'en-IN',mode:'spark',adultDeclared:true}).expect(400);
  await request(f.app).get('/v1/me/onboarding').expect(401);
});

test('complete path uses real prerequisites; expiring verification and new policies reopen missing steps',async()=>{
  const user=await f.user();const h=await f.household(user.userId);const dog=await f.dog(h);
  for(const purpose of ['terms','privacy','community','location']){
    const doc=await f.document(purpose,`complete-${randomUUID()}`);
    await request(f.app).post('/v1/me/consents').set('Authorization',user.header).send({documentId:doc}).expect(200);
  }
  await request(f.app).put('/v1/me/onboarding/preferences').set('Authorization',user.header).send({countryCode:'IN',locale:'en-IN',mode:'pack',adultDeclared:true}).expect(200);
  await request(f.app).put('/v1/me/active-dog').set('Authorization',user.header).send({dogId:dog}).expect(200);
  await f.database.query('INSERT INTO graph.dog_breeds(dog_id,breed_id,percentage) SELECT $1,id,100 FROM graph.breeds LIMIT 1',[dog]);
  await f.database.query("UPDATE identity.households SET cell_coarse='test-anchor' WHERE id=$1",[h]);
  await f.database.query(`INSERT INTO graph.dog_temperament(dog_id,energy,play_style,dog_reactivity,human_reactivity,resource_guarding,recall_reliability,size_tolerance)
    VALUES ($1,3,ARRAY['parallel']::graph.play_style[],2,2,2,3,ARRAY['medium']::graph.size_class[])`,[dog]);
  for(let i=0;i<3;i++)await f.database.query(`INSERT INTO graph.dog_media(id,dog_id,kind,storage_key,ordinal,moderation_state)
    VALUES ($1,$2,'photo','test-only',$3,'approved')`,[randomUUID(),dog,i]);
  await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier,expires_at) VALUES ('user',$1,1,now()+interval '1 day')",[user.userId]);
  const complete=await request(f.app).post('/v1/me/onboarding/complete').set('Authorization',user.header).send({}).expect(200);
  assert.equal(complete.body.ready,true);assert.ok(complete.body.completedAt);
  await request(f.app).patch('/v1/me/preferences').set('Authorization',user.header).send({discoveryPaused:false}).expect(200);
  await f.database.query("UPDATE verify.tiers_granted SET expires_at=now()-interval '1 second' WHERE subject_id=$1",[user.userId]);
  const expired=await state(user.header).expect(200);assert.equal(expired.body.ready,false);assert.ok(expired.body.missing.includes('guardian-verification'));
  await f.document('terms','new-policy');const stale=await state(user.header).expect(200);assert.ok(stale.body.missing.includes('terms-acceptance'));
});
