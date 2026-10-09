import { beforeEach,after,test } from 'node:test';import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';import request from 'supertest';
import { fixture } from '../support/fixture.js';import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';
import { notifyConversation } from '../../src/modules/notifications/notifications.events.js';
import { transaction } from '../../src/db/transaction.js';
const f=fixture(undefined,undefined,new LocalMessageCipher(randomBytes(32).toString('hex'),'test')),http=request(f.app);
beforeEach(()=>f.setup());after(()=>f.close());
test('device registration binds sign-in installation, encrypts token and allows private removal',async()=>{
 const a=await f.user(),b=await f.user(),session=(await f.database.query('SELECT device_id FROM identity.sessions WHERE user_id=$1',[a.userId])).rows[0],id=session.device_id;
 const body={platform:'android',provider:'fcm',token:'TEST_PUSH_TOKEN_NOT_A_SECRET',locale:'en-IN',appBuild:1};
 await http.put(`/v1/me/devices/${randomUUID()}`).set('Authorization',a.header).send(body).expect(403);
 const result=await http.put(`/v1/me/devices/${id}`).set('Authorization',a.header).send(body).expect(200);assert.equal(result.body.pushAvailable,false);assert.ok(!JSON.stringify(result.body).includes(body.token));
 const stored=(await f.database.query('SELECT token_encrypted FROM identity.devices')).rows[0];assert.ok(!stored.token_encrypted.includes(Buffer.from(body.token)));
 await http.delete(`/v1/me/devices/${id}`).set('Authorization',b.header).expect(204);assert.equal((await f.database.query('SELECT count(*)::int n FROM identity.devices')).rows[0].n,1);
 await http.delete(`/v1/me/devices/${id}`).set('Authorization',a.header).expect(204);
});
test('preferences validate timezone and quiet-hour pairs and never claim provider delivery',async()=>{
 const a=await f.user(),path='/v1/me/notification-preferences';const initial=(await http.get(path).set('Authorization',a.header).expect(200)).body;assert.equal(initial.pushAvailable,false);
 const {pushAvailable,...body}=initial;
 await http.put(path).set('Authorization',a.header).send({...body,timezone:'Invalid/Zone'}).expect(400);
 await http.put(path).set('Authorization',a.header).send({...body,quietStart:20}).expect(400);
 const updated=await http.put(path).set('Authorization',a.header).send({...body,pushEnabled:true,quietStart:1320,quietEnd:420}).expect(200);assert.equal(updated.body.pushAvailable,false);assert.equal(updated.body.quietStart,1320);
});
test('inbox events deduplicate atomically, remain private and disappear after blocking',async()=>{
 const a=await f.user(),b=await f.user(),ha=await f.household(a.userId),hb=await f.household(b.userId),dogs=[await f.dog(ha),await f.dog(hb)].sort(),match=randomUUID(),conversation=randomUUID(),event=randomUUID();
 await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);
 await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES($1,$2)',[conversation,match]);
 for(const user of [a,b])await f.database.query('INSERT INTO meetup.conversation_members(conversation_id,user_id) VALUES($1,$2)',[conversation,user.userId]);
 await transaction(f.database,async tx=>{await notifyConversation(tx,conversation,event,'connections');await notifyConversation(tx,conversation,event,'connections');});
 const inbox=(await http.get('/v1/notifications').set('Authorization',a.header).expect(200)).body;assert.equal(inbox.items.length,1);
 assert.equal((await f.database.query('SELECT count(*)::int n FROM ops.push_jobs')).rows[0].n,2);
 await http.post('/v1/notifications/read').set('Authorization',b.header).send({ids:[inbox.items[0].id]}).expect(204);
 assert.equal((await http.get('/v1/notifications').set('Authorization',a.header)).body.items[0].readAt,null);
 await http.post('/v1/notifications/read').set('Authorization',a.header).send({ids:[inbox.items[0].id]}).expect(204);
 assert.ok((await http.get('/v1/notifications').set('Authorization',a.header)).body.items[0].readAt);
 await http.post('/v1/me/blocks').set('Authorization',b.header).send({userId:a.userId}).expect(204);
 assert.equal((await http.get('/v1/notifications').set('Authorization',a.header)).body.items.length,0);
});
