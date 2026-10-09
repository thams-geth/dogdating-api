import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { defaultPolicy } from '../../src/modules/app/policy.js';
import type { Pool } from 'pg';

const app = createApp({ policy: { ...defaultPolicy, android: {
  minimumBuild: 12, latestBuild: 15, storeUrl: 'https://play.google.com/store/apps/details?id=example.test',
} } });

test('bootstrap compares integer builds and reports update boundaries', async () => {
  for (const [build, action] of [[9, 'required'], [12, 'recommended'], [15, 'none'], [20, 'none']] as const) {
    const response = await request(app).get(`/v1/app/bootstrap?platform=android&buildNumber=${build}`).expect(200);
    assert.equal(response.body.update.action, action);
    assert.equal(response.body.country.countryCode, 'IN');
  }
});

test('unknown country stays unavailable and unsupported locale has an explicit fallback', async () => {
  const response = await request(app).get('/v1/app/bootstrap?platform=ios&buildNumber=1&countryCode=US&locale=fr-FR').expect(200);
  assert.equal(response.body.country.countryCode, 'US');
  assert.equal(response.body.country.rollout, 'unavailable');
  assert.equal(response.body.effectiveLocale, 'en-IN');
  assert.equal(response.body.features.spark, false);
});

test('rejects invalid, repeated and unknown query fields', async () => {
  for (const query of ['platform=android&buildNumber=0', 'platform=web&buildNumber=1', 'platform=android&buildNumber=1&buildNumber=2', 'platform=android&buildNumber=1&latitude=10']) {
    const response = await request(app).get(`/v1/app/bootstrap?${query}`).expect(400);
    assert.equal(response.body.code, 'validation-failed');
    assert.match(response.headers['content-type'], /application\/problem\+json/);
  }
});

test('malformed and oversized JSON get client errors without echoing input', async () => {
  const bad = await request(app).post('/missing').set('Content-Type', 'application/json').send('{secret:123}').expect(400);
  assert.equal(bad.body.code, 'invalid-json');
  assert.ok(!JSON.stringify(bad.body).includes('secret'));
  await request(app).post('/missing').send({ data: 'x'.repeat(70_000) }).expect(413);
});

test('readiness fails closed when database/schema is unavailable; liveness remains available', async () => {
  const database = { query: async () => { throw new Error('secret connection detail'); } } as unknown as Pool;
  const unready = createApp({ database });
  await request(unready).get('/v1/health').expect(200);
  const response = await request(unready).get('/v1/ready').expect(503);
  assert.ok(!JSON.stringify(response.body).includes('secret'));
  assert.equal(response.headers['x-request-id'], response.body.requestId);
});

test('invalid release policy fails before serving traffic', () => {
  assert.throws(() => createApp({ policy: { ...defaultPolicy, ios: { minimumBuild: 10, latestBuild: 2, storeUrl: null } } }));
});

test('update gate enforces confirmed minimum builds while leaving recovery routes reachable',async()=>{
 const missing=await request(app).get('/v1/dogs').expect(400);assert.equal(missing.body.code,'app-build-required');
 const old=await request(app).get('/v1/dogs').set('X-App-Platform','android').set('X-App-Build','11').expect(426);assert.equal(old.body.code,'update-required');
 const current=await request(app).get('/v1/dogs').set('X-App-Platform','android').set('X-App-Build','12');assert.notEqual(current.status,426);
 await request(app).get('/v1/app/bootstrap?platform=android&buildNumber=11').expect(200);
 const safety=await request(app).get('/v1/reports/77777777-7777-4777-8777-777777777777').expect(503);assert.notEqual(safety.body.code,'update-required');
});
