import { readFile, writeFile } from 'node:fs/promises';

try {
  const template = await readFile('.env.production.example', 'utf8');
  await writeFile('.env.production', template, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.production from its fail-closed template. Add secrets through your deployment platform; do not commit this file.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env.production already exists; left it unchanged.');
  else throw error;
}
