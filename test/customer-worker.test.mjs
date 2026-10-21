import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCycle } from '../customer-worker.mjs';
import { readJson, exclusiveRun } from '../runner-state.mjs';
import { profileMapping } from '../customer-browser.mjs';

const mapping = { url: 'https://dealer.example/customers', loaded: '#loaded', site: { selector: '#site', expectedText: 'Pilot' }, rows: '.row', fields: {
  external_id: { selector: '.id' }, first_name: { selector: '.first' }, last_name: { selector: '.last' }, email: { selector: '.email' },
} };
const row = { external_id: '1', first_name: 'Test', last_name: 'Person', email: 'test@example.test', observed_at: '2026-10-19T00:00:00Z' };
const client = { apiUrl: 'http://localhost:4000/api/', siteId: 'pilot', organisationId: 'org', preflight: async () => {} };

test('resume an interrupted import from the last confirmed batch without scraping again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-recovery-'));
  try {
    const checkpointPath = join(dir, 'pending.json');
    let reads = 0;
    const read = async () => { reads++; return Array.from({ length: 101 }, (_, i) => ({ ...row, external_id: String(i) })); };
    const options = { mapping, read, checkpointPath, sourceOrigin: 'https://dealer.example', apply: true };
    let calls = 0;
    await assert.rejects(syncCycle({ ...options, client: { ...client, importCustomers: async () => { if (++calls === 2) throw new Error('offline'); } } }), /offline/);
    const saved = await readJson(checkpointPath);
    assert.equal(saved.offset, 100);
    assert.equal(saved.records[100].observed_at, new Date(row.observed_at).toISOString());
    const batches = [];
    await syncCycle({ ...options, client: { ...client, importCustomers: async batch => { batches.push(batch); } } });
    assert.equal(reads, 1);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 1);
    assert.equal(batches[0][0].external_id, '100');
    assert.equal(batches[0][0].observed_at, saved.records[100].observed_at);
    assert.equal(await readJson(checkpointPath), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('checkpoint from another site cannot be resumed or previewed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-site-'));
  try {
    const options = { mapping, checkpointPath: join(dir, 'pending.json'), sourceOrigin: 'https://dealer.example', apply: true, read: async () => [row] };
    await assert.rejects(syncCycle({ ...options, client: { ...client, importCustomers: async () => { throw new Error('offline'); } } }));
    await assert.rejects(syncCycle({ ...options, client: { ...client, siteId: 'another' } }), /CHECKPOINT_SITE_MISMATCH/);
    await assert.rejects(syncCycle({ ...options, client, apply: false }), /PENDING_IMPORT_USE_APPLY/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker lock blocks overlapping runs and is released after failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-lock-'));
  try {
    const path = join(dir, 'worker.lock');
    await assert.rejects(exclusiveRun(path, async () => {
      await assert.rejects(exclusiveRun(path, async () => {}), /RUNNER_ALREADY_LOCKED/);
      throw new Error('stopped');
    }), /stopped/);
    assert.equal(await exclusiveRun(path, async () => 'released'), 'released');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('reject an incomplete profile and unreasonable page limits before browser access', () => {
  assert.throws(() => profileMapping({}), /PROFILE_REQUIRED/);
  assert.throws(() => profileMapping({ ...mapping, maxPages: 0 }), /INVALID_EXTRACTION_LIMIT/);
  assert.equal(profileMapping(mapping).siteText, 'Pilot');
});
