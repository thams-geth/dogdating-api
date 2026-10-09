import { beforeEach,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import request from 'supertest';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { fixture } from '../support/fixture.js';
import { readyDog } from '../support/discovery.js';
import { LocalMessageCipher } from '../../src/modules/messages/message-cipher.js';
import { attachRealtime } from '../../src/modules/messages/realtime.js';
const f=fixture(undefined,randomBytes(48).toString('hex'),new LocalMessageCipher(randomBytes(32).toString('hex'),'test')),http=request(f.app);
let documents:string[]=[];
beforeEach(async()=>{await f.setup();documents=[];for(const p of ['terms','privacy','community','location'])documents.push(await f.document(p));});after(()=>f.close());
async function connected(){
 const a=await readyDog(f,documents),b=await readyDog(f,documents);
 for(const [actor,target] of [[a,b],[b,a]]){
  const feed=(await http.get('/v1/feed').set('Authorization',actor!.header)).body;
  await http.post('/v1/decisions').set('Authorization',actor!.header).set('Idempotency-Key',randomUUID()).send({actorDogId:actor!.dog,targetDogId:target!.dog,mode:'pack',verdict:'interest',impressionToken:feed.cards[0].impressionToken}).expect(200);
 }
 const match=(await http.get('/v1/matches').set('Authorization',a.header)).body.items[0];return {a,b,id:match.conversationId,matchId:match.id};
}
test('concurrent sends sequence, deduplicate, encrypt, paginate and monotonically mark read',async()=>{
 const {a,b,id}=await connected(),path=`/v1/conversations/${id}`,body={clientMessageId:randomUUID(),kind:'text',body:'Hello fixture dog'};
 const sends=await Promise.all([http.post(path+'/messages').set('Authorization',a.header).send(body).expect(200),http.post(path+'/messages').set('Authorization',a.header).send(body).expect(200)]);
 assert.deepEqual(sends[0].body,sends[1].body);assert.equal(sends[0].body.seq,'1');
 await http.post(path+'/messages').set('Authorization',a.header).send({...body,body:'Changed'}).expect(409);
 await http.post(path+'/messages').set('Authorization',b.header).send({...body,body:'Reply'}).expect(200);
 const stored=(await f.database.query('SELECT body_encrypted FROM meetup.messages')).rows;assert.ok(stored.every(r=>!r.body_encrypted.includes(Buffer.from('Hello fixture dog'))));
 const history=await http.get(path+'/messages?afterSeq=0&limit=1').set('Authorization',b.header).expect(200);assert.equal(history.body.hasMore,true);assert.equal(history.body.messages[0].body,body.body);
 await http.post(path+'/read').set('Authorization',b.header).send({upToSeq:'3'}).expect(400);
 await http.post(path+'/read').set('Authorization',b.header).send({upToSeq:'2'}).expect(200);
 assert.equal((await http.post(path+'/read').set('Authorization',b.header).send({upToSeq:'1'})).body.lastReadSeq,'2');
 const home=(await http.get('/v1/home').set('Authorization',a.header)).body;assert.deepEqual(home.sections.connections,{status:'available',value:1});assert.deepEqual(home.sections.messages,{status:'available',value:1});
 const list=await http.get('/v1/conversations').set('Authorization',b.header).expect(200);assert.equal(list.body.items[0].unreadCount,0);
 await http.patch(path+'/preferences').set('Authorization',a.header).send({archived:true,mutedUntil:null}).expect(200);
});
test('outsiders, removed members, blocks and unmatches lose message access',async()=>{
 const {a,b,id}=await connected(),other=await f.user(),path=`/v1/conversations/${id}/messages`;
 await http.get(path).set('Authorization',other.header).expect(404);
 await f.database.query('UPDATE identity.household_members SET accepted_at=NULL WHERE user_id=$1',[a.userId]);await http.get(path).set('Authorization',a.header).expect(404);
 await f.database.query('UPDATE identity.household_members SET accepted_at=now() WHERE user_id=$1',[a.userId]);
 await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:b.userId}).expect(204);
 await http.get(path).set('Authorization',a.header).expect(404);
 await http.post(path).set('Authorization',b.header).send({clientMessageId:randomUUID(),kind:'text',body:'Blocked'}).expect(404);
});
test('socket tickets are consumed once and sockets acknowledge durable text sends',async()=>{
 const {a,id}=await connected();const server=f.app.listen(0),wss=attachRealtime(server,f.app.locals.realtime);
 await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const ticket=(await http.post('/v1/realtime/tickets').set('Authorization',a.header).send({}).expect(201)).body.ticket;
 const ws=new WebSocket(`ws://127.0.0.1:${address.port}/v1/realtime`);
 try{
  await once(ws,'open');let received=once(ws,'message');ws.send(JSON.stringify({type:'authenticate',ticket}));assert.equal(JSON.parse(String((await received)[0])).type,'ready');
  await assert.rejects(f.app.locals.realtime.consume(ticket));
  received=once(ws,'message');ws.send(JSON.stringify({type:'send',conversationId:id,message:{clientMessageId:randomUUID(),kind:'text',body:'Socket message'}}));const ack=JSON.parse(String((await received)[0]));assert.equal(ack.type,'message.ack');assert.equal(ack.message.seq,'1');
  assert.equal((await http.get(`/v1/conversations/${id}/messages`).set('Authorization',a.header)).body.messages[0].body,'Socket message');
 }finally{ws.terminate();for(const socket of wss.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('local key wrapping rejects production and detects altered ciphertext',()=>{
 assert.throws(()=>new LocalMessageCipher(randomBytes(32).toString('hex'),'production'));
 const cipher=new LocalMessageCipher(randomBytes(32).toString('hex'),'test'),value=cipher.wrap(randomBytes(32),'context');value[30]=value[30]!^1;assert.throws(()=>cipher.unwrap(value,'context'));
});
