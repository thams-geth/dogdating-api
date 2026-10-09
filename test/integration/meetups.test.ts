import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';
const f=fixture(undefined,undefined,new LocalMessageCipher(randomBytes(32).toString('hex'),'test')),http=request(f.app),metro='01920000-0000-7000-8000-0000000e0001';
beforeEach(async()=>{await f.setup();await f.database.query('DELETE FROM meetup.places');});after(()=>f.close());
async function pair(){
 const a=await f.user(),b=await f.user(),ha=await f.household(a.userId),hb=await f.household(b.userId),da=await f.dog(ha),db=await f.dog(hb),dogs=[da,db].sort(),matchId=randomUUID(),conversation=randomUUID(),placeId=randomUUID();
 await f.database.query("UPDATE identity.users SET status='active' WHERE id=ANY($1::uuid[])",[[a.userId,b.userId]]);
 await f.database.query('UPDATE identity.households SET metro_id=$1 WHERE id=ANY($2::uuid[])',[metro,[ha,hb]]);
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[matchId,dogs.join(':'),...dogs]);
 await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,matchId]);
 for(const user of [a,b])await f.database.query('INSERT INTO meetup.conversation_members(conversation_id,user_id) VALUES($1,$2)',[conversation,user.userId]);
 await f.database.query("INSERT INTO meetup.places(id,name,kind,latitude,longitude,address,metro_id,state,verified_at) VALUES($1,'TEST PUBLIC PARK','offleash_park',12.9,77.5,'TEST ONLY',$2,'approved',now())",[placeId,metro]);
 const body={matchId,hostDogId:da,guestUserId:b.userId,placeId,kind:'parallel_walk',windowStart:new Date(Date.now()+3600000).toISOString(),windowEnd:new Date(Date.now()+7200000).toISOString()};
 return {a,b,body,placeId,matchId};
}
async function proposal(p:Awaited<ReturnType<typeof pair>>,key=randomUUID()){return (await http.post('/v1/meetups').set('Authorization',p.a.header).set('Idempotency-Key',key).send(p.body).expect(201)).body;}
test('reviewed places only, idempotent proposal and optimistic counter/accept race',async()=>{
 const p=await pair(),key=randomUUID(),m=await proposal(p,key);assert.equal((await proposal(p,key)).id,m.id);
 await http.post(`/v1/meetups/${m.id}/respond`).set('Authorization',p.a.header).send({action:'accept',revision:1}).expect(409);
 const results=await Promise.all([http.post(`/v1/meetups/${m.id}/respond`).set('Authorization',p.b.header).send({action:'accept',revision:1}),http.post(`/v1/meetups/${m.id}/respond`).set('Authorization',p.b.header).send({action:'decline',revision:1})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 await f.database.query("UPDATE meetup.places SET state='pending' WHERE id=$1",[p.placeId]);
 await http.get(`/v1/places/${p.placeId}`).set('Authorization',p.a.header).expect(404);
 await http.post('/v1/meetups').set('Authorization',p.a.header).set('Idempotency-Key',randomUUID()).send(p.body).expect(404);
});
test('counterproposal changes responder; attendance requires acceptance and window; both checkouts complete',async()=>{
 const p=await pair(),m=await proposal(p),path=`/v1/meetups/${m.id}`;
 await http.post(path+'/check-in').set('Authorization',p.a.header).send({revision:1}).expect(409);
 await http.post(path+'/respond').set('Authorization',p.b.header).send({action:'counter',revision:1,placeId:p.placeId,windowStart:p.body.windowStart,windowEnd:p.body.windowEnd}).expect(200);
 await http.post(path+'/respond').set('Authorization',p.b.header).send({action:'accept',revision:2}).expect(409);
 await http.post(path+'/respond').set('Authorization',p.a.header).send({action:'accept',revision:2}).expect(200);
 await http.post(path+'/check-in').set('Authorization',p.a.header).send({revision:3}).expect(409);
 await f.database.query("UPDATE meetup.meetups SET window_start=now()-interval '1 minute',window_end=now()+interval '1 hour' WHERE id=$1",[m.id]);
 let rev=3;for(const action of ['check-in','check-out'])for(const user of [p.a,p.b]){const result=await http.post(path+'/'+action).set('Authorization',user.header).send({revision:rev++}).expect(200);if(rev===7)assert.equal(result.body.state,'completed');}
});
test('blocked and unmatched connections atomically cancel active meetups',async()=>{
 const p=await pair(),m=await proposal(p);await http.post('/v1/me/blocks').set('Authorization',p.a.header).send({userId:p.b.userId}).expect(204);
 const row=(await f.database.query('SELECT state,cancellation_reason FROM meetup.meetups WHERE id=$1',[m.id])).rows[0];assert.equal(row.state,'cancelled');assert.equal(row.cancellation_reason,'connection_ended');
 await http.get(`/v1/meetups/${m.id}`).set('Authorization',p.a.header).expect(404);
});
test('reviews hide peer feedback until both submit and never expose encrypted incident notes',async()=>{
 const p=await pair(),m=await proposal(p),path=`/v1/meetups/${m.id}`;
 await http.post(path+'/respond').set('Authorization',p.b.header).send({action:'accept',revision:1}).expect(200);
 await f.database.query("UPDATE meetup.meetups SET window_start=now()-interval '2 hours',window_end=now()-interval '1 hour' WHERE id=$1",[m.id]);
 const body={showedUp:true,onTime:true,dogAsDescribed:4,humanRespectful:4,playCompatibility:4,wouldRepeat:true,incidentOccurred:true,incidentType:'other',privateNote:'PRIVATE TEST NOTE',publicNote:'Nice walk'};
 await http.post(path+'/reviews').set('Authorization',p.a.header).send(body).expect(201);
 const hidden=(await http.get(path+'/reviews').set('Authorization',p.b.header)).body;assert.equal(hidden.released,false);assert.equal(hidden.reviews.length,0);
 await http.post(path+'/reviews').set('Authorization',p.b.header).send({...body,privateNote:null,incidentOccurred:false,incidentType:null}).expect(201);
 const released=(await http.get(path+'/reviews').set('Authorization',p.b.header)).body;assert.equal(released.released,true);assert.equal(released.reviews.length,2);assert.ok(!JSON.stringify(released).includes('PRIVATE'));assert.ok(!JSON.stringify(released).includes('incident'));
 await http.post(path+'/reviews').set('Authorization',p.a.header).send(body).expect(409);
});
