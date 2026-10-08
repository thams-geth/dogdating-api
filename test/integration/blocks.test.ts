import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
const f=fixture(),http=request(f.app);before(()=>f.setup());after(()=>f.close());
test('blocks are idempotent, private, paginated and cannot target the caller or unknown users',async()=>{
  const a=await f.user(),b=await f.user(),c=await f.user();
  await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:a.userId}).expect(400);
  await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:randomUUID()}).expect(404);
  await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:b.userId,reason:'private'}).expect(400);
  for(const userId of [b.userId,b.userId,c.userId])await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId}).expect(204);
  assert.equal((await http.get('/v1/me/blocks').set('Authorization',b.header).expect(200)).body.blocks.length,0);
  const first=await http.get('/v1/me/blocks?limit=1').set('Authorization',a.header).expect(200);
  assert.equal(first.body.blocks.length,1);assert.ok(first.body.nextCursor);
  await http.get('/v1/me/blocks').query({cursor:first.body.nextCursor}).set('Authorization',b.header).expect(400);
  const second=await http.get('/v1/me/blocks').query({cursor:first.body.nextCursor}).set('Authorization',a.header).expect(200);
  assert.notEqual(first.body.blocks[0].userId,second.body.blocks[0].userId);
  for(let i=0;i<2;i++)await http.delete(`/v1/me/blocks/${b.userId}`).set('Authorization',a.header).expect(204);
});
test('reciprocal blocks serialize and unblock preserves the other direction',async()=>{
  const a=await f.user(),b=await f.user();
  await Promise.all([[a,b],[b,a]].map(([x,y])=>http.post('/v1/me/blocks').set('Authorization',x!.header).send({userId:y!.userId}).expect(204)));
  await http.delete(`/v1/me/blocks/${b.userId}`).set('Authorization',a.header).expect(204);
  assert.equal((await http.get('/v1/me/blocks').set('Authorization',b.header).expect(200)).body.blocks[0].userId,a.userId);
});
test('a block closes existing cross-household matches and conversations; unblock never restores them',async()=>{
  const a=await f.user(),b=await f.user();
  const dogs=[await f.dog(await f.household(a.userId)),await f.dog(await f.household(b.userId))].sort();
  const match=randomUUID(),conversation=randomUUID();
  await f.database.query("INSERT INTO meetup.matches(id,pair_key,dog_a_id,dog_b_id,mode) VALUES ($1,$2,$3,$4,'pack')",[match,dogs.join(':'),...dogs]);
  await f.database.query('INSERT INTO meetup.conversations(id,match_id) VALUES ($1,$2)',[conversation,match]);
  await http.post('/v1/me/blocks').set('Authorization',a.header).send({userId:b.userId}).expect(204);
  await http.delete(`/v1/me/blocks/${b.userId}`).set('Authorization',a.header).expect(204);
  assert.equal((await f.database.query('SELECT state FROM meetup.matches WHERE id=$1',[match])).rows[0].state,'blocked');
  assert.equal((await f.database.query('SELECT state FROM meetup.conversations WHERE id=$1',[conversation])).rows[0].state,'closed');
});
