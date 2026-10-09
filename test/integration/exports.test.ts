import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher,seal } from '../../src/modules/messages/message-cipher.js';import { processAccountExports } from '../../src/modules/safety/account-export.js';
const cipher=new LocalMessageCipher(randomBytes(32).toString('hex'),'test'),f=fixture(undefined,undefined,cipher),http=request(f.app);
beforeEach(()=>f.setup());after(()=>f.close());
const start=async(header:string)=>(await http.post('/v1/me/data-exports').set('Authorization',header).send({}).expect(202)).body;
test('export worker encrypts a scoped snapshot and download needs fresh owner authentication',async()=>{
 const a=await f.user(),b=await f.user();await http.post('/v1/support/tickets').set('Authorization',a.header).set('Idempotency-Key',randomUUID()).send({category:'privacy',message:'MY PRIVATE EXPORT FIXTURE'}).expect(201);
 const job=await start(a.header);assert.equal(job.state,'queued');assert.equal(job.scope,'account_data_v1');
 await http.get(`/v1/me/data-exports/${job.id}/download`).set('Authorization',a.header).expect(409);
 const results=await Promise.all([processAccountExports(f.database,cipher),processAccountExports(f.database,cipher)]);assert.equal(results.reduce((n,r)=>n+r.ready,0),1);
 const status=await http.get(`/v1/me/data-exports/${job.id}`).set('Privacy-Status-Token',job.statusToken).expect(200);assert.equal(status.body.downloadAvailable,true);assert.ok(status.body.expiresAt);
 await http.get(`/v1/me/deletion-requests/${job.id}`).set('Privacy-Status-Token',job.statusToken).expect(404);
 await http.get(`/v1/me/data-exports/${job.id}/download`).set('Privacy-Status-Token',job.statusToken).expect(401);
 await http.get(`/v1/me/data-exports/${job.id}/download`).set('Authorization',b.header).expect(404);
 const file=await http.get(`/v1/me/data-exports/${job.id}/download`).set('Authorization',a.header).expect(200);assert.equal(file.body.data.profile[0].phoneE164,a.phone);assert.equal(file.body.data.authoredSupportMessages[0].body,'MY PRIVATE EXPORT FIXTURE');assert.ok(file.headers['content-disposition'].startsWith('attachment;'));
 const serialized=JSON.stringify(file.body);assert.ok(!serialized.includes(b.phone));for(const value of [a.refreshToken,a.accessToken,'token_hash','body_encrypted','storage_key','phone_blind_index'])assert.ok(!serialized.includes(value));
 const row=(await f.database.query('SELECT result_encrypted FROM identity.privacy_requests WHERE id=$1',[job.id])).rows[0];assert.ok(!row.result_encrypted.includes(Buffer.from(a.phone)));
 await f.database.query("UPDATE identity.sessions SET created_at=now()-interval '1 hour' WHERE user_id=$1",[a.userId]);await http.get(`/v1/me/data-exports/${job.id}/download`).set('Authorization',a.header).expect(403);
});
test('exports include only authored chat text and never another participant message',async()=>{
 const a=await f.user(),b=await f.user(),ha=await f.household(a.userId),hb=await f.household(b.userId),dogs=[await f.dog(ha),await f.dog(hb)].sort(),match=randomUUID(),conversation=randomUUID(),key=randomBytes(32);
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,match]);await f.database.query('INSERT INTO meetup.conversation_keys(conversation_id,wrapped_key) VALUES($1,$2)',[conversation,cipher.wrap(key,conversation)]);
 for(const [i,user,body]of [[1,a,'OWN MESSAGE'],[2,b,'OTHER PRIVATE MESSAGE']] as const){const id=randomUUID();await f.database.query("INSERT INTO meetup.messages(conversation_id,seq,message_id,sender_user_id,kind,body_encrypted) VALUES($1,$2,$3,$4,'text',$5)",[conversation,i,id,user.userId,seal(key,Buffer.from(body),`${conversation}:${id}`)]);}
 const job=await start(a.header);assert.equal((await processAccountExports(f.database,cipher)).ready,1);const file=(await http.get(`/v1/me/data-exports/${job.id}/download`).set('Authorization',a.header)).body;assert.equal(file.data.authoredMessages.length,1);assert.equal(file.data.authoredMessages[0].body,'OWN MESSAGE');assert.ok(!JSON.stringify(file).includes('OTHER PRIVATE MESSAGE'));
});
test('expired artifacts cannot download and worker physically removes ciphertext',async()=>{
 const a=await f.user(),job=await start(a.header);await processAccountExports(f.database,cipher);await f.database.query("UPDATE identity.privacy_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);
 await http.get(`/v1/me/data-exports/${job.id}/download`).set('Authorization',a.header).expect(410);assert.equal((await processAccountExports(f.database,cipher)).expired,1);
 assert.equal((await f.database.query('SELECT result_encrypted FROM identity.privacy_requests WHERE id=$1',[job.id])).rows[0].result_encrypted,null);
});
test('oversized datasets fail to review without silently truncating or exposing partial output',async()=>{
 const a=await f.user(),document=await f.document('privacy');await f.database.query("INSERT INTO identity.consent_events(user_id,document_id,action) SELECT $1,$2,'accepted' FROM generate_series(1,10001)",[a.userId,document]);const job=await start(a.header);const processed=await processAccountExports(f.database,cipher);assert.equal(processed.needsReview,1);
 const row=(await f.database.query('SELECT state,error_code,result_encrypted FROM identity.privacy_requests WHERE id=$1',[job.id])).rows[0];assert.equal(row.state,'needs_review');assert.equal(row.error_code,'export-size-limit');assert.equal(row.result_encrypted,null);
});
