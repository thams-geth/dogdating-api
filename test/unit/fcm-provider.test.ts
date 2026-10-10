import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FcmPushProvider } from '../../src/modules/notifications/fcm-provider.js';

const input = () => ({
  provider: 'fcm', token: 'TEST_REGISTRATION_TOKEN', deliveryId: 'notification:installation',
  payload: { notificationId: 'test-notification', category: 'messages', title: 'Waggle update' as const },
  signal: new AbortController().signal,
});
const fcmError = (code: string, status: number) => new Response(JSON.stringify({ error: { details: [{
  '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: code,
}] } }), { status });

test('FCM sends only generic notification metadata with an OAuth token', async () => {
  let calls = 0;
  const provider = new FcmPushProvider('waggle-test', async () => 'TEST_ACCESS_TOKEN', (async (url, init) => {
    calls++;
    assert.equal(url, 'https://fcm.googleapis.com/v1/projects/waggle-test/messages:send');
    assert.equal((init?.headers as Record<string,string>).Authorization, 'Bearer TEST_ACCESS_TOKEN');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body, { message: {
      token: 'TEST_REGISTRATION_TOKEN', notification: { title: 'Waggle update' },
      data: { notificationId: 'test-notification', category: 'messages', deliveryId: 'notification:installation' },
    } });
    return new Response(JSON.stringify({ name: 'projects/waggle-test/messages/123' }), { status: 200 });
  }) as typeof fetch);
  assert.equal(provider.supports('fcm'), true);
  assert.equal(provider.supports('apns'), false);
  assert.deepEqual(await provider.send(input()), { status: 'delivered' });
  assert.equal(calls, 1);
  assert.throws(() => new FcmPushProvider('../bad-project', async () => 'token'));
});

test('FCM removes only explicitly unregistered tokens', async () => {
  const unregistered = new FcmPushProvider('waggle-test', async () => 'token', (async () => fcmError('UNREGISTERED', 404)) as typeof fetch);
  assert.deepEqual(await unregistered.send(input()), { status: 'invalid_token' });
  const invalidPayload = new FcmPushProvider('waggle-test', async () => 'token', (async () => fcmError('INVALID_ARGUMENT', 400)) as typeof fetch);
  assert.deepEqual(await invalidPayload.send(input()), { status: 'permanent_failure' });
  const missingProject = new FcmPushProvider('waggle-test', async () => 'token', (async () => new Response('{}', { status: 404 })) as typeof fetch);
  assert.deepEqual(await missingProject.send(input()), { status: 'permanent_failure' });
});

test('FCM honors quota retry hints and treats transport failures as transient', async () => {
  const quota = new FcmPushProvider('waggle-test', async () => 'token', (async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })) as typeof fetch);
  assert.deepEqual(await quota.send(input()), { status: 'transient_failure', retryAfterSeconds: 120 });
  const network = new FcmPushProvider('waggle-test', async () => 'token', (async () => { throw new Error('SENSITIVE NETWORK BODY'); }) as typeof fetch);
  assert.deepEqual(await network.send(input()), { status: 'transient_failure' });
  let tokenCalls = 0;
  const stopped = new FcmPushProvider('waggle-test', async () => { tokenCalls++; return 'token'; });
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await stopped.send({ ...input(), signal: controller.signal }), { status: 'transient_failure' });
  assert.equal(tokenCalls, 0);
});
