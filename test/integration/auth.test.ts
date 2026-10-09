import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { DevelopmentOtpSender, LOCAL_TEST_PHONE_E164, LOCAL_TEST_OTP_CODE } from '../../src/modules/auth/otp-sender.js';
import { migrate } from '../../src/db/migrate.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !new URL(connectionString).pathname.endsWith('_test')) {
  throw new Error('Set TEST_DATABASE_URL to a dedicated database whose name ends in _test.');
}
const database = new pg.Pool({ connectionString, max: 12 });
const codes = new Map<string, string>();
const deliveries = new Map<string, number>();
const auth = new AuthService(database, randomBytes(48).toString('hex'), {
  async send(phone, code) { codes.set(phone, code); deliveries.set(phone, (deliveries.get(phone) ?? 0) + 1); },
});
let suffix = 100_000;
const newPhone = () => `+919000${String(suffix++).padStart(6, '0')}`;
const app = () => createApp({ database, auth });
const bearer = (token: string) => `Bearer ${token}`;

before(async () => {
  await migrate(database);
  await migrate(database); // Already-applied migrations must be a no-op.
  await database.query('TRUNCATE identity.otp_challenges, identity.users CASCADE');
});
after(async () => { await database.end(); });

async function login(phone = newPhone()) {
  const http = request(app());
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone, countryCode: 'IN' }).expect(202);
  const response = await http.post('/v1/auth/otp/verify').send({
    phoneE164: phone, code: codes.get(phone), deviceId: randomUUID(), displayName: 'Test Guardian',
  }).expect(200);
  return response.body as { userId: string; accessToken: string; refreshToken: string; expiresIn: number };
}

test('signup returns usable credentials and only a safe private profile projection', async () => {
  const tokens = await login();
  assert.equal(tokens.expiresIn, 900);
  const response = await request(app()).get('/v1/me').set('Authorization', bearer(tokens.accessToken)).expect(200);
  assert.equal(response.body.id, tokens.userId);
  assert.equal(response.body.countryCode, 'IN');
  assert.equal(response.body.status, 'pending');
  assert.equal(response.body.phoneE164Masked.startsWith('******'), true);
  assert.equal('phone_e164' in response.body, false);
  assert.equal('phone_blind_index' in response.body, false);
});

test('fixed development sign-in code still requires an issued, single-use challenge', async () => {
  class QuietDevelopmentSender extends DevelopmentOtpSender { override async send() {} }
  const localAuth = new AuthService(database, randomBytes(48).toString('hex'), new QuietDevelopmentSender('development'));
  const http = request(createApp({ database, auth: localAuth }));
  const body = { phoneE164: LOCAL_TEST_PHONE_E164, code: LOCAL_TEST_OTP_CODE, deviceId: randomUUID(), displayName: 'Local Test Guardian' };
  await http.post('/v1/auth/otp/verify').send(body).expect(401);
  await http.post('/v1/auth/otp/request').send({ phoneE164: LOCAL_TEST_PHONE_E164, countryCode: 'IN' }).expect(202);
  await http.post('/v1/auth/otp/verify').send({ ...body, code: '111111' }).expect(401);
  const response = await http.post('/v1/auth/otp/verify').send(body).expect(200);
  assert.ok(response.body.accessToken);
  await http.post('/v1/auth/otp/verify').send(body).expect(401);
  const row = (await database.query('SELECT attempt_count,consumed_at FROM identity.otp_challenges WHERE phone_blind_index=$1 ORDER BY created_at DESC LIMIT 1', [localAuth.phoneIndex(LOCAL_TEST_PHONE_E164)])).rows[0];
  assert.equal(row.attempt_count, 1);
  assert.ok(row.consumed_at);
});

test('failed guesses remain committed; correct code cannot bypass five-attempt lockout', async () => {
  const phone = newPhone(); const http = request(app());
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  const wrong = codes.get(phone) === '000000' ? '111111' : '000000';
  for (let attempt = 0; attempt < 5; attempt++) {
    await http.post('/v1/auth/otp/verify').send({ phoneE164: phone, code: wrong, deviceId: randomUUID(), displayName: 'Test' }).expect(401);
  }
  await http.post('/v1/auth/otp/verify').send({ phoneE164: phone, code: codes.get(phone), deviceId: randomUUID(), displayName: 'Test' }).expect(401);
  const row = (await database.query('SELECT attempt_count,consumed_at FROM identity.otp_challenges ORDER BY created_at DESC LIMIT 1')).rows[0];
  assert.equal(row.attempt_count, 5);
  assert.ok(row.consumed_at);
});

test('parallel failed guesses cannot exceed the five-attempt budget', async () => {
  const phone = newPhone(); const http = request(app());
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  const wrong = codes.get(phone) === '000000' ? '111111' : '000000';
  const responses = await Promise.all(Array.from({ length: 8 }, () => http.post('/v1/auth/otp/verify').send({ phoneE164: phone, code: wrong, deviceId: randomUUID() })));
  assert.ok(responses.every((response) => response.status === 401));
  const row = (await database.query('SELECT attempt_count FROM identity.otp_challenges ORDER BY created_at DESC LIMIT 1')).rows[0];
  assert.equal(row.attempt_count, 5);
});

test('concurrent OTP requests deliver one code and suppression has the same response', async () => {
  const phone = newPhone(); const http = request(app());
  const responses = await Promise.all(Array.from({ length: 5 }, () => http.post('/v1/auth/otp/request').send({ phoneE164: phone })));
  assert.ok(responses.every((response) => response.status === 202 && response.body.status === 'accepted'));
  assert.equal(deliveries.get(phone), 1);
});

test('new user can supply name after proving phone ownership; consumed code cannot be reused', async () => {
  const phone = newPhone(); const http = request(app()); const deviceId = randomUUID();
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  const body = { phoneE164: phone, code: codes.get(phone), deviceId };
  const missing = await http.post('/v1/auth/otp/verify').send(body).expect(400);
  assert.equal(missing.body.code, 'display-name-required');
  await http.post('/v1/auth/otp/verify').send({ ...body, displayName: 'Guardian' }).expect(200);
  await http.post('/v1/auth/otp/verify').send({ ...body, displayName: 'Guardian' }).expect(401);
});

test('expired OTP is rejected', async () => {
  const phone = newPhone(); const http = request(app());
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  await database.query("UPDATE identity.otp_challenges SET expires_at=now()-interval '1 second' WHERE consumed_at IS NULL");
  await http.post('/v1/auth/otp/verify').send({ phoneE164: phone, code: codes.get(phone), deviceId: randomUUID(), displayName: 'Test' }).expect(401);
});

test('refresh rotates, and reuse durably revokes the entire family including new access token', async () => {
  const tokens = await login(); const http = request(app());
  const refreshed = await http.post('/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(200);
  assert.notEqual(refreshed.body.refreshToken, tokens.refreshToken);
  await http.post('/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
  await http.get('/v1/me').set('Authorization', bearer(refreshed.body.accessToken)).expect(401);
  await http.post('/v1/auth/refresh').send({ refreshToken: refreshed.body.refreshToken }).expect(401);
  const rows = (await database.query('SELECT revoked_at FROM identity.sessions WHERE user_id=$1', [tokens.userId])).rows;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.revoked_at));
});

test('wrong refresh secret cannot revoke a valid session', async () => {
  const tokens = await login(); const http = request(app());
  await http.post('/v1/auth/refresh').send({ refreshToken: `${tokens.refreshToken.split('.')[0]}.${randomBytes(32).toString('base64url')}` }).expect(401);
  await http.get('/v1/me').set('Authorization', bearer(tokens.accessToken)).expect(200);
});

test('concurrent refresh of the same token mints at most one replacement and detects reuse', async () => {
  const tokens = await login(); const http = request(app());
  const responses = await Promise.all([1,2].map(() => http.post('/v1/auth/refresh').send({ refreshToken: tokens.refreshToken })));
  assert.deepEqual(responses.map((response) => response.status).sort(), [200,401]);
  const fresh = responses.find((response) => response.status === 200)!;
  await http.get('/v1/me').set('Authorization', bearer(fresh.body.accessToken)).expect(401);
});

test('session list and device revocation are scoped to the authenticated user', async () => {
  const a = await login(); const b = await login(); const http = request(app());
  const list = await http.get('/v1/auth/sessions').set('Authorization', bearer(a.accessToken)).expect(200);
  assert.equal(list.body.sessions.length, 1);
  assert.equal(list.body.sessions[0].current, true);
  assert.equal('refresh_hash' in list.body.sessions[0], false);
  await http.delete(`/v1/auth/sessions/${b.refreshToken.split('.')[0]}`).set('Authorization', bearer(a.accessToken)).expect(404);
  await http.get('/v1/me').set('Authorization', bearer(b.accessToken)).expect(200);
  await http.delete(`/v1/auth/sessions/${a.refreshToken.split('.')[0]}`).set('Authorization', bearer(a.accessToken)).expect(204);
  await http.get('/v1/me').set('Authorization', bearer(a.accessToken)).expect(401);
});

test('logout invalidates access and refresh', async () => {
  const tokens = await login(); const http = request(app());
  await http.post('/v1/auth/logout').set('Authorization', bearer(tokens.accessToken)).expect(204);
  await http.get('/v1/me').set('Authorization', bearer(tokens.accessToken)).expect(401);
  await http.post('/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
});

test('logout-all revokes multiple device families', async () => {
  const tokens = await login();
  await database.query(`INSERT INTO identity.sessions (id,user_id,device_id,family_id,refresh_hash,expires_at)
    VALUES ($1,$2,$3,$4,'test-unusable',now()+interval '1 day')`, [randomUUID(),tokens.userId,randomUUID(),randomUUID()]);
  await request(app()).post('/v1/auth/logout-all').set('Authorization', bearer(tokens.accessToken)).expect(204);
  const row = (await database.query('SELECT count(*)::int AS count FROM identity.sessions WHERE user_id=$1 AND revoked_at IS NULL', [tokens.userId])).rows[0];
  assert.equal(row.count, 0);
});

test('profile writes reject privilege fields and invalid timezone; account state gates auth', async () => {
  const tokens = await login(); const http = request(app()); const header = bearer(tokens.accessToken);
  await http.patch('/v1/me').set('Authorization', header).send({ status: 'active', isAdultVerified: true }).expect(400);
  await http.patch('/v1/me').set('Authorization', header).send({ timezone: 'Mars/Test' }).expect(400);
  const updated = await http.patch('/v1/me').set('Authorization', header).send({ displayName: 'New Name' }).expect(200);
  assert.equal(updated.body.displayName, 'New Name');
  await database.query("UPDATE identity.users SET status='suspended' WHERE id=$1", [tokens.userId]);
  await http.get('/v1/me').set('Authorization', header).expect(401);
  await http.post('/v1/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401);
});

test('signed-in guardian cannot use a malformed bearer token', async () => {
  await request(app()).get('/v1/me').expect(401);
  await request(app()).get('/v1/me').set('Authorization', 'Bearer invalid').expect(401);
});

test('delivery failure keeps response generic and leaves challenge unusable', async () => {
  const phone = newPhone(); let captured = '';
  const failingAuth = new AuthService(database, randomBytes(48).toString('hex'), { async send(_phone, code) { captured = code; throw new Error('private provider failure'); } });
  const http = request(createApp({ database, auth: failingAuth }));
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  await http.post('/v1/auth/otp/verify').send({ phoneE164: phone, code: captured, deviceId: randomUUID(), displayName: 'Test' }).expect(401);
});

test('hourly phone send budget survives retries and resend cooldown', async () => {
  const phone = newPhone(); const http = request(app());
  for (let attempt = 0; attempt < 4; attempt++) {
    // Age this test's most recent row past cooldown without waiting a minute.
    if (attempt > 0) await database.query("UPDATE identity.otp_challenges SET created_at=created_at-interval '61 seconds' WHERE created_at>now()-interval '1 hour'");
    await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  }
  assert.equal(deliveries.get(phone), 3);
});

test('returning users sign in without a name and reuse their existing account', async () => {
  const phone = newPhone(); const initial = await login(phone); const http = request(app());
  await database.query("UPDATE identity.otp_challenges SET created_at=created_at-interval '61 seconds' WHERE created_at>now()-interval '1 hour'");
  await http.post('/v1/auth/otp/request').send({ phoneE164: phone }).expect(202);
  const response = await http.post('/v1/auth/otp/verify').send({ phoneE164: phone, code: codes.get(phone), deviceId: randomUUID() }).expect(200);
  assert.equal(response.body.userId, initial.userId);
});
