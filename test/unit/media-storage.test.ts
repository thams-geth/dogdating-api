import assert from 'node:assert/strict';
import test from 'node:test';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3PhotoStorage } from '../../src/modules/media/media.storage.js';

test('S3 photo storage keeps processed images private under the photo prefix', async () => {
  const commands: unknown[] = [];
  const client = {
    async send(command: unknown) {
      commands.push(command);
      if (command instanceof GetObjectCommand) return { Body: { async transformToByteArray() { return Uint8Array.from([1, 2, 3]); } } };
      return {};
    },
  };
  const storage = new S3PhotoStorage('waggle-dev-media-example', 'ap-south-1', client);
  const key = '11111111-1111-4111-8111-111111111111.jpg';
  await storage.put(key, Buffer.from([1, 2, 3]));
  assert.ok(commands[0] instanceof PutObjectCommand);
  assert.deepEqual((commands[0] as PutObjectCommand).input, {
    Bucket: 'waggle-dev-media-example', Key: `photos/${key}`, Body: Buffer.from([1, 2, 3]),
    ContentType: 'image/jpeg', CacheControl: 'private, no-store', ServerSideEncryption: 'AES256',
  });
  assert.deepEqual(await storage.get(key), Buffer.from([1, 2, 3]));
  assert.ok(commands[1] instanceof GetObjectCommand);
  await storage.remove(key);
  assert.ok(commands[2] instanceof DeleteObjectCommand);
});

test('S3 photo storage rejects caller-controlled object paths', async () => {
  const storage = new S3PhotoStorage('waggle-dev-media-example', 'ap-south-1', { async send() { return {}; } });
  await assert.rejects(storage.put('../private', Buffer.from('x')), /Invalid internal photo key/);
});
