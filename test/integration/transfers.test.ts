import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';
const f=fixture(),http=request(f.app);beforeEach(()=>f.setup());after(()=>f.close());
async function setup(){const a=await f.user(),b=await f.user(),c=await f.user(),source=await f.household(a.userId),target=await f.household(b.userId),dog=await f.dog(source);return {a,b,c,source,target,dog};}
async function start(p:Awaited<ReturnType<typeof setup>>){return (await http.post(`/v1/dogs/${p.dog}/transfer`).set('Authorization',p.a.header).send({targetHouseholdId:p.target,recipientUserId:p.b.userId,shareRecords:true}).expect(201)).body;}
test('two-party transfer requires recipient identity/token and removes old owner access atomically',async()=>{
 const p=await setup();await http.put('/v1/me/active-dog').set('Authorization',p.a.header).send({dogId:p.dog}).expect(200);
 const transfer=await start(p);assert.ok(transfer.token);assert.notEqual((await f.database.query('SELECT token_hash FROM graph.dog_transfers')).rows[0].token_hash,transfer.token);
 await http.post(`/v1/dog-transfers/${transfer.id}/accept`).set('Authorization',p.c.header).send({token:transfer.token,acceptRecords:true}).expect(404);
 await http.post(`/v1/dog-transfers/${transfer.id}/accept`).set('Authorization',p.b.header).send({token:randomBytes(32).toString('base64url'),acceptRecords:true}).expect(404);
 for(let i=0;i<2;i++)await http.post(`/v1/dog-transfers/${transfer.id}/accept`).set('Authorization',p.b.header).send({token:transfer.token,acceptRecords:true}).expect(200);
 await http.get(`/v1/dogs/${p.dog}`).set('Authorization',p.a.header).expect(404);const dog=(await http.get(`/v1/dogs/${p.dog}`).set('Authorization',p.b.header).expect(200)).body;assert.equal(dog.householdId,p.target);assert.equal(dog.publicationState,'draft');
 assert.equal((await f.database.query('SELECT active_dog_id FROM identity.user_preferences WHERE user_id=$1',[p.a.userId])).rows[0].active_dog_id,null);
 assert.equal((await http.get('/v1/dog-transfers').set('Authorization',p.c.header)).body.items.length,0);
});
test('current owner roles, expiry and cancellation are rechecked at acceptance',async()=>{
 const p=await setup(),transfer=await start(p);await f.database.query('UPDATE identity.household_members SET accepted_at=NULL WHERE household_id=$1',[p.source]);
 await http.post(`/v1/dog-transfers/${transfer.id}/accept`).set('Authorization',p.b.header).send({token:transfer.token,acceptRecords:true}).expect(404);
 await f.database.query('UPDATE identity.household_members SET accepted_at=now() WHERE household_id=$1',[p.source]);await f.database.query("UPDATE graph.dog_transfers SET expires_at=now()-interval '1 second' WHERE id=$1",[transfer.id]);
 await http.post(`/v1/dog-transfers/${transfer.id}/accept`).set('Authorization',p.b.header).send({token:transfer.token,acceptRecords:true}).expect(409);
 const next=await start(p);await http.delete(`/v1/dog-transfers/${next.id}`).set('Authorization',p.b.header).expect(204);
 await http.post(`/v1/dog-transfers/${next.id}/accept`).set('Authorization',p.b.header).send({token:next.token,acceptRecords:true}).expect(409);
});
test('transfer closes old matches and revokes dog grants without transferring conversations',async()=>{
 const p=await setup(),otherHousehold=await f.household(p.c.userId),otherDog=await f.dog(otherHousehold),dogs=[p.dog,otherDog].sort(),match=randomUUID(),conversation=randomUUID();
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,match]);
 await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier) VALUES('dog',$1,2)",[p.dog]);
 const transfer=await start(p);await http.post(`/v1/dog-transfers/${transfer.id}/accept`).set('Authorization',p.b.header).send({token:transfer.token,acceptRecords:true}).expect(200);
 assert.equal((await f.database.query('SELECT state FROM meetup.matches WHERE id=$1',[match])).rows[0].state,'ended');assert.equal((await f.database.query('SELECT state FROM meetup.conversations WHERE id=$1',[conversation])).rows[0].state,'closed');assert.ok((await f.database.query('SELECT revoked_at FROM verify.tiers_granted WHERE subject_id=$1',[p.dog])).rows[0].revoked_at);
});
