import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface PhotoStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

type S3Transport = { send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<unknown> };

/** Private durable storage. Authentication comes from the AWS SDK credential chain (ECS task role in AWS). */
export class S3PhotoStorage implements PhotoStorage {
  private readonly client: S3Transport;
  constructor(private readonly bucket: string, region: string, client?: S3Transport) {
    if (!bucket || !region) throw new Error('S3 photo storage requires a bucket and region.');
    this.client = client ?? new S3Client({ region });
  }
  private key(key: string) {
    if (!/^[a-f0-9-]{36}\.jpg$/.test(key)) throw new Error('Invalid internal photo key.');
    return `photos/${key}`;
  }
  async put(key: string, bytes: Buffer) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(key),
      Body: bytes,
      ContentType: 'image/jpeg',
      CacheControl: 'private, no-store',
      ServerSideEncryption: 'AES256',
    }));
  }
  async get(key: string) {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!result.Body) throw new Error('S3 returned an empty photo body.');
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }
}

/** Private local development adapter. Never mount this directory as static content. */
export class LocalPhotoStorage implements PhotoStorage {
  constructor(private readonly directory: string, environment: string) {
    if (!['development', 'test'].includes(environment)) throw new Error('Local photos are development/test only.');
  }
  private path(key: string) {
    if (!/^[a-f0-9-]{36}\.jpg$/.test(key)) throw new Error('Invalid internal photo key.');
    return resolve(this.directory, key);
  }
  async put(key: string, bytes: Buffer) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(key), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  get(key: string) { return readFile(this.path(key)); }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
    // Also recover temporary writes left behind by a process crash.
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const file of files) if (file.startsWith(`${key}.`) && file.endsWith('.tmp')) await rm(resolve(this.directory, file), { force: true });
  }
}
