import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
const f=fixture();before(()=>f.setup());after(()=>f.close());
const http=request(f.app);
async function createHousehold(header:string,name='My dogs'){return (await http.post('/v1/households').set('Authorization',header).send({name}).expect(201)).body;}
async function createDog(header:string,householdId:string){return (await http.post('/v1/dogs').set('Authorization',header).send({householdId,name:'Ruby',sex:'female',sizeClass:'medium',dateOfBirth:'2023-01-01',neutered:true}).expect(201)).body;}
async function invite(owner:{header:string},h:string,recipient:{header:string;phone:string},role='co_guardian'){
 const response=await http.post(`/v1/households/${h}/invitations`).set('Authorization',owner.header).send({phoneE164:recipient.phone,role}).expect(201);
 await http.post(`/v1/household-invitations/${response.body.inviteToken}/accept`).set('Authorization',recipient.header).send({}).expect(200);
 return response.body;
}

test('household creation atomically makes its creator owner and hides private location data',async()=>{
 const a=await f.user(),b=await f.user();const h=await createHousehold(a.header);
 assert.equal(h.role,'owner');assert.equal('geo_salt' in h,false);assert.equal('cell_coarse' in h,false);
 const list=await http.get('/v1/households').set('Authorization',a.header).expect(200);assert.equal(list.body.households.length,1);
 const other=await http.get('/v1/households').set('Authorization',b.header).expect(200);assert.equal(other.body.households.length,0);
 await http.get(`/v1/households/${h.id}`).set('Authorization',b.header).expect(404);
 await http.patch(`/v1/households/${h.id}`).set('Authorization',b.header).send({name:'Stolen'}).expect(404);
 await http.post('/v1/households').set('Authorization',a.header).send({name:'Unsafe',geoSalt:'test',role:'owner'}).expect(400);
 const members=await http.get(`/v1/households/${h.id}/members`).set('Authorization',a.header).expect(200);assert.equal(members.body.members[0].userId,a.userId);assert.equal('phoneE164' in members.body.members[0],false);
});

test('invitation is phone-bound, single-use and stores only the token hash',async()=>{
 const owner=await f.user(),recipient=await f.user(),wrong=await f.user();const h=await createHousehold(owner.header);
 const issued=await http.post(`/v1/households/${h.id}/invitations`).set('Authorization',owner.header).send({phoneE164:recipient.phone,role:'walker'}).expect(201);
 const token=issued.body.inviteToken;
 await http.post(`/v1/household-invitations/${token}/accept`).set('Authorization',wrong.header).send({}).expect(404);
 const stored=(await f.database.query('SELECT * FROM identity.household_invitations WHERE id=$1',[issued.body.invitationId])).rows[0];assert.ok(!JSON.stringify(stored).includes(token));assert.ok(!JSON.stringify(stored).includes(recipient.phone));
 await http.post(`/v1/household-invitations/${token}/accept`).set('Authorization',recipient.header).send({}).expect(200);
 await http.post(`/v1/household-invitations/${token}/accept`).set('Authorization',recipient.header).send({}).expect(409);
 await http.patch(`/v1/households/${h.id}`).set('Authorization',recipient.header).send({name:'Forbidden'}).expect(403);
 await http.post(`/v1/households/${h.id}/invitations`).set('Authorization',recipient.header).send({phoneE164:wrong.phone}).expect(403);
});

test('expired invitations cannot be accepted and old invitations do not downgrade members',async()=>{
 const owner=await f.user(),recipient=await f.user();const h=await createHousehold(owner.header);
 const old=await http.post(`/v1/households/${h.id}/invitations`).set('Authorization',owner.header).send({phoneE164:recipient.phone}).expect(201);
 await f.database.query("UPDATE identity.household_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[old.body.invitationId]);
 await http.post(`/v1/household-invitations/${old.body.inviteToken}/accept`).set('Authorization',recipient.header).send({}).expect(409);
 await invite(owner,h.id,recipient);
 const another=await http.post(`/v1/households/${h.id}/invitations`).set('Authorization',owner.header).send({phoneE164:recipient.phone,role:'view_only'}).expect(201);
 await http.post(`/v1/household-invitations/${another.body.inviteToken}/accept`).set('Authorization',recipient.header).send({}).expect(409);
});

test('concurrent owner self-demotions cannot orphan a household',async()=>{
 const a=await f.user(),b=await f.user();const h=await createHousehold(a.header);await invite(a,h.id,b);
 await http.patch(`/v1/households/${h.id}/members/${b.userId}`).set('Authorization',a.header).send({role:'owner'}).expect(204);
 const responses=await Promise.all([a,b].map(user=>http.patch(`/v1/households/${h.id}/members/${user.userId}`).set('Authorization',user.header).send({role:'co_guardian'})));
 assert.deepEqual(responses.map(r=>r.status).sort(),[204,409]);
 const remaining=(await f.database.query("SELECT user_id FROM identity.household_members WHERE household_id=$1 AND role='owner'",[h.id])).rows;assert.equal(remaining.length,1);
 const current=remaining[0].user_id===a.userId?a:b;
 await http.delete(`/v1/households/${h.id}/members/${current.userId}`).set('Authorization',current.header).expect(409);
});

test('dog drafts enforce household roles and live membership revocation',async()=>{
 const owner=await f.user(),co=await f.user(),viewer=await f.user(),stranger=await f.user();const h=await createHousehold(owner.header);
 await invite(owner,h.id,co);await invite(owner,h.id,viewer,'view_only');const dog=await createDog(owner.header,h.id);assert.equal(dog.publicationState,'draft');
 await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',co.header).send({name:'Ruby II'}).expect(200);
 await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',viewer.header).send({name:'No'}).expect(403);
 await http.get(`/v1/dogs/${dog.id}`).set('Authorization',viewer.header).expect(200);
 await http.get(`/v1/dogs/${dog.id}`).set('Authorization',stranger.header).expect(404);
 await http.post('/v1/dogs').set('Authorization',stranger.header).send({householdId:h.id,name:'No',sex:'male',sizeClass:'small'}).expect(404);
 await http.delete(`/v1/households/${h.id}/members/${co.userId}`).set('Authorization',owner.header).expect(204);
 await http.get(`/v1/dogs/${dog.id}`).set('Authorization',co.header).expect(404);
 await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',co.header).send({name:'No'}).expect(404);
});

test('calendar dates, neutering dates and write allowlists are validated on merged patches',async()=>{
 const user=await f.user(),h=await createHousehold(user.header),dog=await createDog(user.header,h.id);
 for(const body of [{dateOfBirth:'2025-02-30'},{dateOfBirth:'2999-01-01'},{neuteredAt:'2020-01-01'},{status:'active'},{householdId:randomUUID()},{microchipVerifiedAt:new Date().toISOString()}])
  await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',user.header).send(body).expect(400);
 await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',user.header).send({neuteredAt:'2024-01-01'}).expect(200);
 await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',user.header).send({neutered:false}).expect(400);
 const cleared=await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',user.header).send({neutered:false,neuteredAt:null,bio:null}).expect(200);assert.equal(cleared.body.neuteredAt,null);
});

test('breed replacement requires valid unique percentages and cannot self-award DNA evidence',async()=>{
 const user=await f.user(),h=await createHousehold(user.header),dog=await createDog(user.header,h.id);
 const breed=(await f.database.query('SELECT id FROM graph.breeds LIMIT 1')).rows[0].id;
 for(const breeds of [[{breedId:breed,percentage:90}],[{breedId:breed,percentage:50},{breedId:breed,percentage:50}],[{breedId:randomUUID(),percentage:100}],[{breedId:breed,percentage:100,source:'dna_test'}]])
  await http.put(`/v1/dogs/${dog.id}/breeds`).set('Authorization',user.header).send({breeds}).expect(400);
 const saved=await http.put(`/v1/dogs/${dog.id}/breeds`).set('Authorization',user.header).send({breeds:[{breedId:breed,percentage:100}]}).expect(200);
 assert.equal(saved.body.breeds[0].source,'declared');
});

test('temperament, preference ranges and availability windows are persisted and validated',async()=>{
 const user=await f.user(),h=await createHousehold(user.header),dog=await createDog(user.header,h.id);
 const temperament={questionnaireVersion:1,energy:3,playStyle:['parallel'],dogReactivity:4,humanReactivity:2,resourceGuarding:1,recallReliability:3,sizeTolerance:['medium']};
 await http.put(`/v1/dogs/${dog.id}/temperament`).set('Authorization',user.header).send({...temperament,energy:6}).expect(400);
 await http.put(`/v1/dogs/${dog.id}/temperament`).set('Authorization',user.header).send(temperament).expect(200);
 await http.put(`/v1/dogs/${dog.id}/preferences`).set('Authorization',user.header).send({ageMinMonths:50,ageMaxMonths:10}).expect(400);
 await http.put(`/v1/dogs/${dog.id}/preferences`).set('Authorization',user.header).send({acceptsReactive:true,parallelWalkOnly:false}).expect(400);
 await http.put(`/v1/dogs/${dog.id}/preferences`).set('Authorization',user.header).send({acceptsReactive:true,parallelWalkOnly:true}).expect(200);
 const window={dayOfWeek:1,startMin:600,endMin:660};
 await http.put(`/v1/dogs/${dog.id}/availability`).set('Authorization',user.header).send({timezone:'Asia/Kolkata',windows:[window,{...window,startMin:630}]}).expect(400);
 await http.put(`/v1/dogs/${dog.id}/availability`).set('Authorization',user.header).send({timezone:'Asia/Kolkata',windows:[window]}).expect(200);
 const read=await http.get(`/v1/dogs/${dog.id}`).set('Authorization',user.header).expect(200);assert.equal(read.body.temperament.dogReactivity,4);assert.deepEqual(read.body.availability.windows,[window]);
});

test('list cursors are scoped and traversal has no duplicates',async()=>{
 const a=await f.user(),b=await f.user(),h=await createHousehold(a.header);const ids=[];
 for(let i=0;i<3;i++)ids.push((await createDog(a.header,h.id)).id);
 let cursor:string|null=null;const seen:string[]=[];
 do {const response=await http.get(`/v1/dogs?limit=1${cursor?'&cursor='+cursor:''}`).set('Authorization',a.header).expect(200);
  seen.push(...response.body.dogs.map((d:any)=>d.id));cursor=response.body.nextCursor;
  if(cursor){await http.get(`/v1/dogs?cursor=${cursor}`).set('Authorization',b.header).expect(400);await http.get(`/v1/households?cursor=${cursor}`).set('Authorization',a.header).expect(400);}
 }while(cursor);
 assert.deepEqual(seen.sort(),ids.sort());await http.get('/v1/dogs?limit=51').set('Authorization',a.header).expect(400);
});

test('publishing stays gated and memorialisation cannot be reversed by profile edits',async()=>{
 const owner=await f.user(),co=await f.user(),h=await createHousehold(owner.header);await invite(owner,h.id,co);const dog=await createDog(owner.header,h.id);
 await http.post(`/v1/dogs/${dog.id}/publish`).set('Authorization',owner.header).send({}).expect(409);
 await http.post(`/v1/dogs/${dog.id}/beacon`).set('Authorization',owner.header).send({durationMinutes:91}).expect(400);
 await http.post(`/v1/dogs/${dog.id}/beacon`).set('Authorization',owner.header).send({durationMinutes:30}).expect(409);
 await http.post(`/v1/dogs/${dog.id}/memorialise`).set('Authorization',co.header).send({}).expect(403);
 const memorial=await http.post(`/v1/dogs/${dog.id}/memorialise`).set('Authorization',owner.header).send({}).expect(200);assert.equal(memorial.body.status,'memorialised');assert.equal(memorial.body.publicationState,'paused');
 await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',owner.header).send({name:'Restore'}).expect(409);
 await http.put('/v1/me/active-dog').set('Authorization',owner.header).send({dogId:dog.id}).expect(404);
});

test('eligible dog can publish, beacon is capped/cancellable, and identity edits invalidate publication/evidence',async()=>{
 const user=await f.user(),h=await createHousehold(user.header),dog=await createDog(user.header,h.id);
 for(const purpose of ['terms','privacy','community','location']){
  const documentId=await f.document(purpose,'publishing-test');
  await http.post('/v1/me/consents').set('Authorization',user.header).send({documentId}).expect(200);
 }
 await http.put('/v1/me/onboarding/preferences').set('Authorization',user.header).send({countryCode:'IN',locale:'en-IN',mode:'pack',adultDeclared:true}).expect(200);
 await http.put('/v1/me/active-dog').set('Authorization',user.header).send({dogId:dog.id}).expect(200);
 const breed=(await f.database.query('SELECT id FROM graph.breeds LIMIT 1')).rows[0].id;
 await http.put(`/v1/dogs/${dog.id}/breeds`).set('Authorization',user.header).send({breeds:[{breedId:breed,percentage:100}]}).expect(200);
 await http.put(`/v1/dogs/${dog.id}/temperament`).set('Authorization',user.header).send({questionnaireVersion:1,energy:3,playStyle:['parallel'],dogReactivity:2,humanReactivity:2,resourceGuarding:1,recallReliability:3,sizeTolerance:['medium']}).expect(200);
 // Synthetic evidence only in the dedicated test DB; public APIs cannot create verification grants.
 await f.database.query("UPDATE identity.households SET cell_coarse='test-anchor' WHERE id=$1",[h.id]);
 await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier) VALUES ('user',$1,1),('dog',$2,2)",[user.userId,dog.id]);
 for(let ordinal=0;ordinal<3;ordinal++)await f.database.query(`INSERT INTO graph.dog_media(id,dog_id,kind,storage_key,ordinal,moderation_state)
  VALUES ($1,$2,'photo','fixture-only',$3,'approved')`,[randomUUID(),dog.id,ordinal]);
 const published=await http.post(`/v1/dogs/${dog.id}/publish`).set('Authorization',user.header).send({}).expect(200);assert.equal(published.body.publicationState,'published');
 await http.patch('/v1/me/preferences').set('Authorization',user.header).send({discoveryPaused:false}).expect(200);
 const beacon=await http.post(`/v1/dogs/${dog.id}/beacon`).set('Authorization',user.header).send({durationMinutes:90}).expect(200);
 assert.ok(new Date(beacon.body.beaconUntil).getTime()-Date.now()<=90*60_000);
 await http.put(`/v1/dogs/${dog.id}/availability`).set('Authorization',user.header).send({timezone:'Asia/Kolkata',windows:[{dayOfWeek:1,startMin:600,endMin:660}]}).expect(200);
 await http.delete(`/v1/dogs/${dog.id}/beacon`).set('Authorization',user.header).expect(204);
 const windows=(await f.database.query('SELECT day_of_week FROM graph.dog_availability WHERE dog_id=$1',[dog.id])).rows;assert.equal(windows.length,1);assert.equal(windows[0].day_of_week,1);
 const changed=await http.patch(`/v1/dogs/${dog.id}`).set('Authorization',user.header).send({name:'Ruby corrected'}).expect(200);assert.equal(changed.body.publicationState,'draft');
 const tier=(await f.database.query("SELECT revoked_at FROM verify.tiers_granted WHERE subject_type='dog' AND subject_id=$1",[dog.id])).rows[0];assert.ok(tier.revoked_at);
});
