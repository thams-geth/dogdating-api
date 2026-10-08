import { beforeEach,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
import { readyDog } from '../support/discovery.js';
const f=fixture(undefined,randomBytes(48).toString('hex')),http=request(f.app);
let documents:string[]=[];
beforeEach(async()=>{await f.setup();documents=[];for(const p of ['terms','privacy','community','location'])documents.push(await f.document(p));});
after(()=>f.close());
const ready=()=>readyDog(f,documents);
async function input(a:Awaited<ReturnType<typeof ready>>,b:Awaited<ReturnType<typeof ready>>){
 const feed=await http.get('/v1/feed').set('Authorization',a.header).expect(200);
 return {actorDogId:a.dog,targetDogId:b.dog,mode:'pack',verdict:'interest',impressionToken:feed.body.cards.find((c:{id:string})=>c.id===b.dog).impressionToken};
}
const post=(header:string,body:unknown,key=randomUUID())=>http.post('/v1/decisions').set('Authorization',header).set('Idempotency-Key',key).send(body);
test('reciprocal interests atomically create one connection and retry consumes quota once',async()=>{
 const a=await ready(),b=await ready(),ab=await input(a,b),ba=await input(b,a),key=randomUUID();
 const results=await Promise.all([post(a.header,ab,key).expect(200),post(b.header,ba).expect(200)]);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM meetup.matches')).rows[0].n,1);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM meetup.conversation_members')).rows[0].n,2);
 const retry=await post(a.header,ab,key).expect(200);assert.deepEqual(retry.body,results[0].body);
 await post(a.header,{...ab,verdict:'pass'},key).expect(409);
 const allowance=await http.get('/v1/me/entitlements').set('Authorization',a.header).expect(200);assert.equal(allowance.body.remaining,11);
 const matches=await http.get('/v1/matches').set('Authorization',a.header).expect(200);assert.equal(matches.body.items.length,1);
 const id=matches.body.items[0].id;await http.delete(`/v1/matches/${id}`).set('Authorization',a.header).expect(204);
 await http.delete(`/v1/matches/${id}`).set('Authorization',a.header).expect(204);
 await http.get(`/v1/matches/${id}`).set('Authorization',b.header).expect(404);
 await post(b.header,ba).expect(409);
});
test('pending lists provide scoped impressions; withdrawal is private and does not refund quota',async()=>{
 const a=await ready(),b=await ready(),outsider=await ready();
 const decision=await post(a.header,await input(a,b)).expect(200);
 const incoming=await http.get('/v1/likes/received').set('Authorization',b.header).query({dogId:b.dog}).expect(200);
 assert.equal(incoming.body.items[0].dog.id,a.dog);assert.ok(incoming.body.items[0].impressionToken);
 await http.delete(`/v1/likes/${decision.body.id}`).set('Authorization',outsider.header).expect(404);
 await http.delete(`/v1/likes/${decision.body.id}`).set('Authorization',a.header).expect(204);
 await http.delete(`/v1/likes/${decision.body.id}`).set('Authorization',a.header).expect(204);
 assert.equal((await http.get('/v1/likes/received').set('Authorization',b.header).query({dogId:b.dog})).body.items.length,0);
 assert.equal((await http.get('/v1/me/entitlements').set('Authorization',a.header)).body.remaining,11);
});
test('fresh decisions check token and durable cap; passes cost no interest',async()=>{
 const a=await ready(),b=await ready(),ab=await input(a,b);
 await post(a.header,{...ab,impressionToken:ab.impressionToken+'x'}).expect(400);
 await f.database.query("INSERT INTO meetup.interest_usage(user_id,day,used) VALUES($1,(now() AT TIME ZONE 'Asia/Kolkata')::date,12)",[a.userId]);
 await post(a.header,ab).expect(429);await post(a.header,{...ab,verdict:'pass'}).expect(200);
});
test('block racing reciprocal interest leaves no active connection or open conversation',async()=>{
 const a=await ready(),b=await ready(),ab=await input(a,b),ba=await input(b,a);
 await post(a.header,ab).expect(200);
 const results=await Promise.all([post(b.header,ba),http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:b.userId})]);
 assert.ok([200,404].includes(results[0].status));assert.equal(results[1].status,204);
 assert.equal((await f.database.query("SELECT count(*)::int n FROM meetup.matches WHERE state='active'")).rows[0].n,0);
 assert.equal((await f.database.query("SELECT count(*)::int n FROM meetup.conversations WHERE state='open'")).rows[0].n,0);
 await post(a.header,ab).expect(404);
});
