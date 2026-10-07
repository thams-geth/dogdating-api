import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';

let contents;
try { contents = await readFile('.env', 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; contents = await readFile('.env.example', 'utf8'); }
const current = parse(contents);
if (current.NODE_ENV && current.NODE_ENV !== 'development') throw new Error('Refusing to change a non-development environment.');
const values = { NODE_ENV: 'development', OTP_MODE: 'development', AUTH_SECRET: current.AUTH_SECRET || randomBytes(48).toString('hex') };
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  contents = pattern.test(contents) ? contents.replace(pattern, `${key}=${value}`) : `${contents}\n${key}=${value}\n`;
}
await writeFile('.env', contents, { mode: 0o600 });
console.log('Local OTP delivery enabled in .env. Codes appear only in the development terminal; use synthetic test numbers.');
