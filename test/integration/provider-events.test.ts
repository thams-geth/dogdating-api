import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import request from 'supertest';
import type { VerifiedProviderEvent, VerificationEventVerifier } from '../../src/modules/verification/provider-events.js';
import { fixture } from '../support/fixture.js';

// Disposable fixture protocol. The production server never installs this verifier.
const secret = 'test-only-verification-callback-secret';
const signer: VerificationEventVerifier = { async verify(raw: Buffer, headers: IncomingHttpHeaders) {
  const stamp = headers['x-test-timestamp'], signature = headers['x-test-signature'];
  if (typeof stamp !== 'string' || typeof signature !== 'string' || !/^\d{13}$/.test(stamp) ||
      Math.abs(Date.now() - Number(stamp)) > 300_000 || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid fixture signature');
  const expected = createHmac('sha256', secret).update(stamp).update('.').update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid fixture signature');
  return JSON.parse(raw.toString('utf8')) as VerifiedProviderEvent;
} };
const f = fixture(undefined, undefined, undefined, undefined, signer), http = request(f.app);
before(() => f.setup());
after(() => f.close());

const event = (requestId: string, subjectType: 'user'|'dog', subjectId: string, outcome: VerifiedProviderEvent['outcome'] = 'approved'): VerifiedProviderEvent => ({
  provider: 'fixture', eventId: randomUUID(), requestId, providerRef: `fixture:${randomUUID()}`,
  subjectType, subjectId, assurance: subjectType === 'user' ? 'adult_identity' : 'dog_identity', outcome,
  expiresAt: outcome === 'approved' ? new Date(Date.now() + 30 * 86400_000).toISOString() : null,
});
const signed = (body: VerifiedProviderEvent, overrideSignature?: string) => {
  const raw = JSON.stringify(body), stamp = Date.now().toString();
  const signature = overrideSignature ?? createHmac('sha256', secret).update(stamp).update('.').update(raw).digest('hex');
  return http.post('/webhooks/verification').set('Content-Type', 'application/json').set('X-Test-Timestamp', stamp).set('X-Test-Signature', signature).send(raw);
};

test('authenticated guardian event grants tier and is replay-safe', async () => {
  const user = await f.user();
  const created = await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian'}).expect(201);
  const body = event(created.body.id, 'user', user.userId);
  assert.deepEqual((await signed(body).expect(200)).body, {accepted:true,requestId:created.body.id,duplicate:false});
  assert.equal((await signed(body).expect(200)).body.duplicate, true);
  const status = await http.get(`/v1/verifications/${created.body.id}`).set('Authorization', user.header).expect(200);
  assert.equal(status.body.state, 'approved');
  const grant = (await f.database.query("SELECT expires_at,source_request FROM verify.tiers_granted WHERE subject_type='user' AND subject_id=$1 AND tier=1", [user.userId])).rows[0];
  assert.equal(grant.source_request, created.body.id);
  assert.ok(grant.expires_at);
  assert.equal((await f.database.query('SELECT is_adult_verified FROM identity.users WHERE id=$1', [user.userId])).rows[0].is_adult_verified, true);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM verify.provider_events WHERE request_id=$1', [created.body.id])).rows[0].n, 1);
});

test('invalid signature, changed event ID payload and withdrawn requests cannot create grants', async () => {
  const user = await f.user();
  const created = await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian'}).expect(201);
  const body = event(created.body.id, 'user', user.userId, 'needs_more_info');
  await signed(body, '0'.repeat(64)).expect(401);
  await signed(body).expect(200);
  assert.equal((await http.get(`/v1/verifications/${created.body.id}`).set('Authorization', user.header).expect(200)).body.state, 'needs_more_info');
  await signed({...body, outcome:'rejected'}).expect(409);
  await http.post(`/v1/verifications/${created.body.id}/withdraw`).set('Authorization', user.header).send({}).expect(200);
  await signed(event(created.body.id, 'user', user.userId)).expect(409);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM verify.tiers_granted WHERE subject_id=$1', [user.userId])).rows[0].n, 0);
});

test('dog ownership is rechecked before a signed event grants a tier', async () => {
  const owner = await f.user(), requester = await f.user(), household = await f.household(owner.userId), dog = await f.dog(household);
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES($1,$2,'co_guardian',now())", [household,requester.userId]);
  const created = await http.post('/v1/verifications').set('Authorization', requester.header).send({kind:'dog',dogId:dog}).expect(201);
  await f.database.query("UPDATE identity.household_members SET role='view_only' WHERE household_id=$1 AND user_id=$2", [household,requester.userId]);
  await signed(event(created.body.id, 'dog', dog)).expect(409);
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM verify.tiers_granted WHERE subject_id=$1', [dog])).rows[0].n, 0);
});

test('eligible dog approval grants only its dog tier', async () => {
  const user = await f.user(), household = await f.household(user.userId), dog = await f.dog(household);
  const created = await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'dog',dogId:dog}).expect(201);
  await signed(event(created.body.id, 'dog', dog)).expect(200);
  const grants = (await f.database.query('SELECT subject_type,tier FROM verify.tiers_granted WHERE subject_id=$1', [dog])).rows;
  assert.deepEqual(grants, [{subject_type:'dog',tier:2}]);
  assert.equal((await f.database.query('SELECT is_adult_verified FROM identity.users WHERE id=$1', [user.userId])).rows[0].is_adult_verified, false);
});

test('rejected evidence finalizes the request without a tier', async () => {
  const user = await f.user();
  const created = await http.post('/v1/verifications').set('Authorization', user.header).send({kind:'guardian'}).expect(201);
  await signed(event(created.body.id, 'user', user.userId, 'rejected')).expect(200);
  const status = await http.get(`/v1/verifications/${created.body.id}`).set('Authorization', user.header).expect(200);
  assert.equal(status.body.state, 'rejected');
  assert.equal(status.body.reasonCode, 'provider_rejected');
  assert.equal((await f.database.query('SELECT count(*)::int AS n FROM verify.tiers_granted WHERE subject_id=$1', [user.userId])).rows[0].n, 0);
});

test('default server has no provider verifier', async () => {
  const unconfigured = fixture();
  try {
    const response = await request(unconfigured.app).post('/webhooks/verification').set('Content-Type','application/json').send('{}').expect(503);
    assert.equal(response.body.code, 'verification-provider-unavailable');
  } finally { await unconfigured.close(); }
});
