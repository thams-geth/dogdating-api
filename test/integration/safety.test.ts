import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';
const f=fixture(undefined,undefined,new LocalMessageCipher(randomBytes(32).toString('hex'),'test')),http=request(f.app);
beforeEach(()=>f.setup());after(()=>f.close());
async function privacy(user:Awaited<ReturnType<typeof f.user>>){await f.database.query("UPDATE identity.otp_challenges SET created_at=now()-interval '2 minutes'");await http.post('/v1/privacy/deletion/otp/request').send({phoneE164:user.phone,countryCode:'IN'}).expect(202);return (await http.post('/v1/privacy/deletion/otp/verify').send({phoneE164:user.phone,code:f.code(user.phone)}).expect(200)).body.token;}
test('private support has scoped encrypted history and retry-safe replies',async()=>{
 const a=await f.user(),b=await f.user(),key=randomUUID(),body={category:'privacy',message:'Private support fixture'};
 const create=()=>http.post('/v1/support/tickets').set('Authorization',a.header).set('Idempotency-Key',key).send(body).expect(201);
 const ticket=(await create()).body;assert.equal((await create()).body.id,ticket.id);
 await http.get(`/v1/support/tickets/${ticket.id}`).set('Authorization',b.header).expect(404);
 const detail=(await http.get(`/v1/support/tickets/${ticket.id}`).set('Authorization',a.header)).body;assert.equal(detail.messages[0].body,body.message);
 const row=(await f.database.query('SELECT body_encrypted FROM safety.support_messages')).rows[0];assert.ok(!row.body_encrypted.includes(Buffer.from(body.message)));
 const replyKey=randomUUID();for(let i=0;i<2;i++)await http.post(`/v1/support/tickets/${ticket.id}/messages`).set('Authorization',a.header).set('Idempotency-Key',replyKey).send({message:'Follow-up'}).expect(201);
 assert.equal((await http.get(`/v1/support/tickets/${ticket.id}`).set('Authorization',a.header)).body.messages.length,2);
});
test('privacy OTP is purpose-bound, creates no accounts and allows suspended-user appeals only in safety scope',async()=>{
 const a=await f.user();await f.database.query("UPDATE identity.users SET status='suspended' WHERE id=$1",[a.userId]);const token=await privacy(a);
 await http.get('/v1/me').set('Privacy-Token',token).expect(401);
 const action=randomUUID();await f.database.query("INSERT INTO safety.enforcement_actions(id,subject_type,subject_id,action,reason_code,policy_ref) VALUES($1,'user',$2,'suspend','test','TEST POLICY FIXTURE')",[action,a.userId]);
 const appeal=await http.post('/v1/me/appeals').set('Privacy-Token',token).send({actionId:action,statement:'Please review the fixture decision'}).expect(201);assert.equal(appeal.body.state,'submitted');
 assert.equal((await http.get('/v1/me/safety-notices').set('Privacy-Token',token)).body.items.length,1);
 const phone='+919999123456';await http.post('/v1/privacy/deletion/otp/request').send({phoneE164:phone,countryCode:'IN'}).expect(202);
 await http.post('/v1/auth/otp/verify').send({phoneE164:phone,code:f.code(phone),deviceId:randomUUID(),displayName:'Must not create'}).expect(401);
 await http.post('/v1/privacy/deletion/otp/verify').send({phoneE164:phone,code:f.code(phone)}).expect(401);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM identity.users')).rows[0].n,1);
});
test('deletion requests revoke sessions, block reauthentication, retain honest tracked status and require recent proof',async()=>{
 const a=await f.user();await f.database.query("UPDATE identity.sessions SET created_at=now()-interval '1 hour' WHERE user_id=$1",[a.userId]);
 await http.post('/v1/me/deletion-requests').set('Authorization',a.header).send({}).expect(403);
 const token=await privacy(a);const result=(await http.post('/v1/me/deletion-requests').set('Privacy-Token',token).send({}).expect(202)).body;
 assert.equal(result.completed,false);assert.equal(result.state,'needs_review');
 await http.get('/v1/me').set('Authorization',a.header).expect(401);
 await http.get(`/v1/me/deletion-requests/${result.id}`).set('Privacy-Status-Token',result.statusToken).expect(200);
 await http.get(`/v1/me/deletion-requests/${result.id}`).set('Privacy-Status-Token',randomBytes(32).toString('base64url')).expect(404);
 assert.ok((await f.database.query('SELECT deletion_requested_at FROM identity.users WHERE id=$1',[a.userId])).rows[0].deletion_requested_at);
});
test('reports reject guessed subjects and remain available after connection blocking',async()=>{
 const a=await f.user(),b=await f.user(),ha=await f.household(a.userId),hb=await f.household(b.userId),dogs=[await f.dog(ha),await f.dog(hb)].sort(),match=randomUUID(),conversation=randomUUID(),message=randomUUID();
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,match]);
 for(const user of [a,b])await f.database.query('INSERT INTO meetup.conversation_members(conversation_id,user_id) VALUES($1,$2)',[conversation,user.userId]);
 await f.database.query("INSERT INTO meetup.messages(conversation_id,seq,message_id,sender_user_id,kind) VALUES($1,1,$2,$3,'text')",[conversation,message,b.userId]);
 await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:b.userId}).expect(204);
 const report=(subjectId:string)=>http.post('/v1/reports').set('Authorization',a.header).set('Idempotency-Key',randomUUID()).send({subjectType:'message',subjectId,category:'harassment',details:'Private report fixture'});
 await report(randomUUID()).expect(404);const result=await report(message).expect(201);await http.get(`/v1/reports/${result.body.id}`).set('Authorization',b.header).expect(404);
 assert.equal((await http.get(`/v1/reports/${result.body.id}`).set('Authorization',a.header)).body.state,'queued');
});
