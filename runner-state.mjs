import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RunnerError } from './backend-client.mjs';

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function exclusiveRun(path, task) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new RunnerError('RUNNER_ALREADY_LOCKED'); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await task();
  } finally { await lock.close(); await unlink(path); }
}
