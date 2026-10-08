import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
const f = fixture(), http = request(f.app);
before(() => f.setup()); after(() => f.close());
async function setup() { const user = await f.user(), household = await f.household(user.userId), dog = await f.dog(household); return {user, household, dog}; }
const health = {recordType: 'rabies', testedAt: '2024-01-01', expiresAt: '2025-01-01'};

test('guardian requests bind the subject to the caller, stay unverified and deduplicate concurrent retries', async () => {
  const user = await f.user();
  const results = await Promise.all([1,2].map(() => http.post('/v1/verifications').set('Authorization', user.header).send({kind: 'guardian'}).expect(201)));
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(results[0].body.subjectId, user.userId); assert.equal(results[0].body.targetTier, 1);
  assert.equal(results[0].body.state, 'pending'); assert.equal(results[0].body.nextAction, 'awaiting_provider_setup');
  assert.equal('provider_ref' in results[0].body, false);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM verify.tiers_granted WHERE subject_id=$1', [user.userId])).rows[0].n, 0);
  await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian',targetTier:4}).expect(400);
  await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian',aadhaarNumber:'synthetic'}).expect(400);
  await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian',state:'approved'}).expect(400);
});

test('verification status/withdrawal are requester-scoped, terminal transitions are protected, and limits persist', async () => {
  const user = await f.user(), other = await f.user();
  for (let i = 0; i < 3; i++) {
    const created = await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian'}).expect(201);
    await http.get(`/v1/verifications/${created.body.id}`).set('Authorization', other.header).expect(404);
    await http.post(`/v1/verifications/${created.body.id}/withdraw`).set('Authorization', other.header).send({}).expect(404);
    for (let j = 0; j < 2; j++) {
      const withdrawn = await http.post(`/v1/verifications/${created.body.id}/withdraw`).set('Authorization', user.header).send({}).expect(200);
      assert.equal(withdrawn.body.state, 'withdrawn'); assert.equal(withdrawn.body.nextAction, 'none');
    }
  }
  await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian'}).expect(429);
  const terminal = await http.post('/v1/verifications').set('Authorization', other.header).send({kind:'guardian'}).expect(201);
  await f.database.query("UPDATE verify.verification_requests SET state='rejected' WHERE id=$1", [terminal.body.id]);
  await http.post(`/v1/verifications/${terminal.body.id}/withdraw`).set('Authorization', other.header).send({}).expect(409);
});

test('dog requests require an editor and lose access immediately after household removal', async () => {
  const {user, household, dog} = await setup(), member = await f.user(), stranger = await f.user();
  await http.post('/v1/verifications').set('Authorization', stranger.header).send({kind:'dog',dogId:dog}).expect(404);
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'view_only',now())", [household,member.userId]);
  await http.post('/v1/verifications').set('Authorization', member.header).send({kind:'dog',dogId:dog}).expect(403);
  await f.database.query("UPDATE identity.household_members SET role='co_guardian' WHERE household_id=$1 AND user_id=$2", [household,member.userId]);
  const created = await http.post('/v1/verifications').set('Authorization', member.header).send({kind:'dog',dogId:dog}).expect(201);
  assert.equal(created.body.targetTier, 2);
  await http.get(`/v1/verifications/${created.body.id}`).set('Authorization', user.header).expect(404);
  await f.database.query('DELETE FROM identity.household_members WHERE household_id=$1 AND user_id=$2', [household,member.userId]);
  await http.get(`/v1/verifications/${created.body.id}`).set('Authorization', member.header).expect(404);
});

test('health records reject invalid dates and verification fields; expired reports stay explicitly self-reported', async () => {
  const {user,dog} = await setup();
  for (const input of [{...health,testedAt:'2025-02-30'}, {...health,testedAt:'2999-01-01'}, {...health,expiresAt:'2023-01-01'}, {...health,testedAt:'2020-01-01'}, {...health,verifiedAt:'2024-01-01'}, {...health,documentStorageKey:'secret'}]) {
    await http.post(`/v1/dogs/${dog}/health-records`).set('Authorization',user.header).send(input).expect(400);
  }
  const created = await http.post(`/v1/dogs/${dog}/health-records`).set('Authorization',user.header).send(health).expect(201);
  assert.equal(created.body.provenance, 'self_reported'); assert.equal(created.body.expired, true); assert.equal(created.body.verifiedAt, null);
  assert.equal('document_storage_key' in created.body, false);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM verify.tiers_granted WHERE subject_id=$1', [dog])).rows[0].n, 0);
});

test('health lists and deletion are household-scoped, paginated and do not expose document references', async () => {
  const {user,household,dog} = await setup(), member = await f.user(), stranger = await f.user();
  const a = await http.post(`/v1/dogs/${dog}/health-records`).set('Authorization',user.header).send(health).expect(201);
  await http.post(`/v1/dogs/${dog}/health-records`).set('Authorization',user.header).send({...health,recordType:'vet_exam'}).expect(201);
  const list = await http.get(`/v1/dogs/${dog}/health-records?limit=1`).set('Authorization',user.header).expect(200);
  assert.equal(list.body.records.length, 1); assert.ok(list.body.nextCursor);
  const second = await http.get(`/v1/dogs/${dog}/health-records`).query({cursor:list.body.nextCursor,limit:1}).set('Authorization',user.header).expect(200);
  assert.notEqual(list.body.records[0].id, second.body.records[0].id);
  await http.get(`/v1/dogs/${dog}/health-records`).set('Authorization',stranger.header).expect(404);
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'view_only',now())", [household,member.userId]);
  await http.get(`/v1/dogs/${dog}/health-records`).query({cursor:list.body.nextCursor}).set('Authorization',member.header).expect(400);
  await http.get(`/v1/dogs/${dog}/health-records`).set('Authorization',member.header).expect(200);
  await http.delete(`/v1/dogs/${dog}/health-records/${a.body.id}`).set('Authorization',member.header).expect(403);
  for (let i = 0; i < 2; i++) await http.delete(`/v1/dogs/${dog}/health-records/${a.body.id}`).set('Authorization',user.header).expect(204);
  assert.equal((await http.get(`/v1/dogs/${dog}/health-records`).set('Authorization',user.header).expect(200)).body.records.length, 1);
});

test('removing reviewed evidence revokes health tiers and pauses publication without revoking guardian/dog identity tiers', async () => {
  const {user,dog} = await setup();
  const record = await http.post(`/v1/dogs/${dog}/health-records`).set('Authorization',user.header).send(health).expect(201);
  // Synthetic review evidence is confined to the disposable test database.
  await f.database.query('UPDATE verify.health_records SET verified_at=now(),verified_by=$2 WHERE id=$1', [record.body.id,user.userId]);
  await f.database.query("INSERT INTO verify.tiers_granted(subject_type,subject_id,tier) VALUES ('dog',$1,2),('dog',$1,3)", [dog]);
  await f.database.query("UPDATE graph.dogs SET publication_state='published' WHERE id=$1", [dog]);
  await http.delete(`/v1/dogs/${dog}/health-records/${record.body.id}`).set('Authorization',user.header).expect(204);
  const tiers = (await f.database.query("SELECT tier,revoked_at FROM verify.tiers_granted WHERE subject_type='dog' AND subject_id=$1 ORDER BY tier", [dog])).rows;
  assert.equal(tiers[0].revoked_at, null); assert.ok(tiers[1].revoked_at);
  assert.equal((await f.database.query('SELECT publication_state FROM graph.dogs WHERE id=$1', [dog])).rows[0].publication_state, 'draft');
});
