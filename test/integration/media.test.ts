import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { fixture } from '../support/fixture.js';
import { LocalPhotoStorage } from '../../src/modules/media/media.storage.js';
import { MediaService } from '../../src/modules/media/media.service.js';

const directory = await mkdtemp(join(tmpdir(), 'waggle-media-test-'));
const storage = new LocalPhotoStorage(directory, 'test');
const f = fixture(storage), http = request(f.app);
before(() => f.setup());
after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }); });
const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#aa6633' } }).png().withMetadata().toBuffer();
const input = (bytes = png) => ({ contentType: 'image/png', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
async function setup() { const user = await f.user(), household = await f.household(user.userId), dog = await f.dog(household); return { user, household, dog }; }
async function start(user: {header: string}, dog: string, bytes = png) { return (await http.post(`/v1/dogs/${dog}/media/uploads`).set('Authorization', user.header).send(input(bytes)).expect(201)).body; }
async function upload(user: {header: string}, id: string, bytes = png) { return http.put(`/v1/media/${id}/content`).set('Authorization', user.header).set('Content-Type', 'image/png').send(bytes); }

test('real photos are re-encoded without metadata and remain pending after idempotent completion', async () => {
  const {user, dog} = await setup(), media = await start(user, dog);
  assert.equal(media.upload.authentication, 'bearer');
  assert.equal('storage_key' in media, false);
  await upload(user, media.id).then(r => assert.equal(r.status, 200));
  const bytes = await storage.get(`${media.id}.jpg`), metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 32); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
  for (let i = 0; i < 2; i++) {
    const done = await http.post(`/v1/media/${media.id}/complete`).set('Authorization', user.header).send({}).expect(200);
    assert.equal(done.body.uploadState, 'completed'); assert.equal(done.body.moderationState, 'pending');
  }
  await http.get(`/v1/media/${media.id}/content`).set('Authorization', user.header).expect(404);
  const list = await http.get(`/v1/dogs/${dog}/media`).set('Authorization', user.header).expect(200);
  assert.equal(list.body.media.length, 1); assert.equal('url' in list.body.media[0], false);
});

test('photos enforce authentication, editor roles and immediate membership revocation', async () => {
  const {user, household, dog} = await setup(), stranger = await f.user(), member = await f.user(), media = await start(user, dog);
  await http.put(`/v1/media/${media.id}/content`).set('Content-Type', 'image/png').send(png).expect(401);
  await http.get(`/v1/media/${media.id}`).set('Authorization', stranger.header).expect(404);
  await f.database.query("INSERT INTO identity.household_members(household_id,user_id,role,accepted_at) VALUES ($1,$2,'view_only',now())", [household, member.userId]);
  await http.get(`/v1/media/${media.id}`).set('Authorization', member.header).expect(200);
  await upload(member, media.id).then(r => assert.equal(r.status, 403));
  await f.database.query("UPDATE identity.household_members SET role='co_guardian' WHERE household_id=$1 AND user_id=$2", [household, member.userId]);
  await upload(member, media.id).then(r => assert.equal(r.status, 403)); // uploader binding
  await f.database.query('DELETE FROM identity.household_members WHERE household_id=$1 AND user_id=$2', [household, member.userId]);
  await http.get(`/v1/media/${media.id}`).set('Authorization', member.header).expect(404);
});

test('checksum, declared type, byte limits, decode failures and write allowlists fail closed', async () => {
  const {user, dog} = await setup(), media = await start(user, dog);
  await upload(user, media.id, Buffer.from('wrong')).then(r => assert.equal(r.status, 400));
  await http.put(`/v1/media/${media.id}/content`).set('Authorization', user.header).set('Content-Type', 'image/svg+xml').send('<svg/>').expect(415);
  const invalid = await start(user, dog, Buffer.from('not a PNG'));
  await upload(user, invalid.id, Buffer.from('not a PNG')).then(r => assert.equal(r.status, 400));
  const truncated = png.subarray(0, 20), broken = await start(user, dog, truncated);
  await upload(user, broken.id, truncated).then(r => assert.equal(r.status, 400));
  await http.post(`/v1/dogs/${dog}/media/uploads`).set('Authorization', user.header).send({...input(), moderationState: 'approved'}).expect(400);
  await http.post(`/v1/dogs/${dog}/media/uploads`).set('Authorization', user.header).send({...input(), sizeBytes: 8388609}).expect(400);
  await http.put(`/v1/media/${media.id}/content`).set('Authorization', user.header).set('Content-Type', 'image/png').send(Buffer.alloc(8388609)).expect(413);
  await http.post(`/v1/media/${media.id}/complete`).set('Authorization', user.header).send({}).expect(409);
});

test('concurrent content submission consumes an upload once and expiry prevents completion', async () => {
  const {user, dog} = await setup(), media = await start(user, dog);
  const results = await Promise.all([upload(user, media.id), upload(user, media.id)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  await f.database.query("UPDATE graph.media_uploads SET expires_at=now()-interval '1 minute' WHERE media_id=$1", [media.id]);
  await http.post(`/v1/media/${media.id}/complete`).set('Authorization', user.header).send({}).expect(410);
  const expired = await start(user, dog);
  await f.database.query("UPDATE graph.media_uploads SET expires_at=now()-interval '1 minute' WHERE media_id=$1", [expired.id]);
  await upload(user, expired.id).then(r => assert.equal(r.status, 410));
  const service = new MediaService(f.database, storage);
  assert.equal((await service.cleanup()).cleaned, 2);
  assert.equal((await service.cleanup()).cleaned, 0);
  await assert.rejects(storage.get(`${media.id}.jpg`));
});

test('ordering validates a complete owned set; deletion invalidates publication and frees slots', async () => {
  const {user, dog} = await setup(), a = await start(user, dog), b = await start(user, dog);
  await upload(user, a.id);
  await http.patch(`/v1/dogs/${dog}/media/order`).set('Authorization', user.header).send({mediaIds: [b.id, a.id]}).expect(204);
  await http.patch(`/v1/dogs/${dog}/media/order`).set('Authorization', user.header).send({mediaIds: [b.id, b.id]}).expect(400);
  await http.patch(`/v1/dogs/${dog}/media/order`).set('Authorization', user.header).send({mediaIds: [a.id]}).expect(400);
  const list = await http.get(`/v1/dogs/${dog}/media`).set('Authorization', user.header).expect(200);
  assert.deepEqual(list.body.media.map((r: {id: string}) => r.id), [b.id, a.id]);
  await f.database.query("UPDATE graph.dogs SET publication_state='published' WHERE id=$1", [dog]);
  await http.delete(`/v1/dogs/${dog}/media/${a.id}`).set('Authorization', user.header).expect(204);
  await assert.rejects(storage.get(`${a.id}.jpg`));
  assert.equal((await f.database.query('SELECT publication_state FROM graph.dogs WHERE id=$1', [dog])).rows[0].publication_state, 'draft');
  assert.equal((await start(user, dog)).ordinal, 1);
});

test('cleanup retries physical deletion after a storage failure', async () => {
  const {user, dog} = await setup(), media = await start(user, dog); await upload(user, media.id);
  const failing = new MediaService(f.database, { put: (k,b) => storage.put(k,b), get: k => storage.get(k), async remove() { throw new Error('Storage unavailable'); } });
  await assert.rejects(failing.remove(user.userId, dog, media.id));
  assert.equal((await f.database.query('SELECT cleanup_required FROM graph.media_uploads WHERE media_id=$1', [media.id])).rows[0].cleanup_required, true);
  await http.get(`/v1/media/${media.id}`).set('Authorization', user.header).expect(404);
  await new MediaService(f.database, storage).cleanup();
  await assert.rejects(storage.get(`${media.id}.jpg`));
});

test('local adapter forbids production and traversal, and leaves no temporary files', async () => {
  assert.throws(() => new LocalPhotoStorage(directory, 'production'));
  assert.throws(() => storage.get('../secret'));
  assert.ok((await readdir(directory)).every(name => name.endsWith('.jpg')));
});
