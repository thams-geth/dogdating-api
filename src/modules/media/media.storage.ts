import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PhotoStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
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
