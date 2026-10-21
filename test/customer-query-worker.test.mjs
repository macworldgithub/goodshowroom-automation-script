import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryPlan, runQueryPlan, mergeObservations, archiveCompletedQuery } from '../customer-query-worker.mjs';
import { collectQueryPages } from '../era-customer-pilot.mjs';
import { readJson } from '../runner-state.mjs';
import { atomicJson } from '../runner-state.mjs';
import { readdir } from 'node:fs/promises';

const site = { code: '01', label: '01| Example Site', backendSiteId: 'test-site' };
const inventory = { sourceOrigin: 'https://dealer.example', sites: [site] };
const input = { version: 1, sourceOrigin: inventory.sourceOrigin, siteCode: site.code, coverage: 'filtered_query_set', queries: ['ADAMS', 'JONES'] };
const record = (external_id, extra = {}) => ({ external_id, first_name: 'Sample', last_name: 'Person', email: 'sample@example.test', observed_at: '2026-10-19T00:00:00Z', ...extra });
const result = records => ({ records, selected: records.length, skipped: {}, coverage: 'filtered_query_pages' });

test('query plans cannot claim complete coverage or silently target an unmapped site', () => {
  assert.equal(queryPlan(input, inventory).queries.length, 2);
  for (const extra of [{ coverage: 'complete' }, { siteCode: '02' }, { queries: ['ADAMS', ' adams '] }, { maxRecordsPerQuery: 1001 }, { sourceOrigin: 'https://other.example' }]) {
    assert.throws(() => queryPlan({ ...input, ...extra }, inventory));
  }
});

test('all-page reads reject repeated, changed and truncated source pages', async () => {
  let page = 1;
  const options = { readPage: async () => ({ position: { current: page, total: 2 }, ids: [`id-${page}`] }), nextPage: async value => { page = value; } };
  assert.deepEqual((await collectQueryPages(options)).map(row => row.id), ['id-1', 'id-2']);
  await assert.rejects(collectQueryPages({ readPage: async () => ({ position: { current: 1, total: 2 }, ids: ['id'] }), nextPage: async () => {} }), /SOURCE_PAGES_CHANGED/);
  page = 1;
  await assert.rejects(collectQueryPages({ ...options, readPage: async () => ({ position: { current: page, total: 2 }, ids: ['same-id'] }) }), /DUPLICATE_ID/);
  page = 1;
  await assert.rejects(collectQueryPages({ ...options, maxRecords: 1 }), /RECORD_LIMIT/);
});

test('overlapping queries merge stable IDs and refuse contradictory same-time observations', () => {
  assert.equal(mergeObservations([record('id-1')], [record('id-1')]).length, 1);
  assert.throws(() => mergeObservations([record('id-1')], [record('id-1', { first_name: 'Conflict' })]), /CONFLICTING_QUERY_OBSERVATIONS/);
  const newer = record('id-1', { first_name: 'Updated', observed_at: '2026-10-19T01:00:00Z' });
  assert.equal(mergeObservations([record('id-1')], [newer])[0].first_name, 'Updated');
});

test('resume skips completed source queries and a lost import response never changes observations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-query-'));
  try {
    const statePath = join(dir, 'state.json');
    const plan = queryPlan(input, inventory);
    let readCalls = 0;
    await assert.rejects(runQueryPlan({ plan, statePath, read: async () => {
      if (++readCalls === 2) throw new Error('source unavailable');
      return result([record('id-1')]);
    } }), /source unavailable/);
    assert.equal((await readJson(statePath)).completedQueries, 1);
    const preview = await runQueryPlan({ plan, statePath, read: async ({ query }) => {
      assert.equal(query, 'JONES'); return result([record('id-1'), record('id-2')]);
    } });
    assert.equal(preview.records, 2);
    const original = (await readJson(statePath)).records;
    let submissions = 0;
    const client = { siteId: site.backendSiteId, apiUrl: 'http://localhost:4000/api/', organisationId: 'org',
      preflight: async () => ({}), importCustomers: async records => {
        assert.deepEqual(records, original);
        if (++submissions === 1) throw new Error('acknowledgement lost');
      }, verifyImportedCustomers: async records => ({ verified: records.length }),
    };
    const options = { plan, statePath, client, apply: true, read: async () => assert.fail('Must reuse saved observations') };
    await assert.rejects(runQueryPlan(options), /acknowledgement lost/);
    const applied = await runQueryPlan(options);
    assert.equal(applied.verified, 2);
    assert.deepEqual((await readJson(statePath)).records, original);
    assert.equal((await readJson(statePath)).phase, 'verified');
    await assert.rejects(runQueryPlan({ ...options, plan: { ...plan, queries: ['DIFFERENT'] } }), /CHECKPOINT_PLAN_MISMATCH/);
    await assert.rejects(runQueryPlan({ ...options, client: { ...client, apiUrl: 'http://localhost:5000/api/' } }), /QUERY_IMPORT_BACKEND_MISMATCH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an interrupted customer detail read resumes its individual record checkpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-query-detail-'));
  try {
    const statePath = join(dir, 'state.json');
    const plan = queryPlan({ ...input, queries: ['ADAMS'] }, inventory);
    await assert.rejects(runQueryPlan({ plan, statePath, read: async ({ onRecord }) => {
      await onRecord({ id: 'id-1', customer: record('id-1') });
      throw new Error('session expired');
    } }), /session expired/);
    assert.equal((await readJson(statePath)).activeQuery.items.length, 1);
    await runQueryPlan({ plan, statePath, read: async ({ completed, onRecord }) => {
      assert.equal(completed[0].customer.observed_at, '2026-10-19T00:00:00Z');
      await onRecord({ id: 'id-2', customer: record('id-2') });
      return result([completed[0].customer, record('id-2')]);
    } });
    const state = await readJson(statePath);
    assert.equal(state.records.length, 2);
    assert.equal(state.activeQuery, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refresh preserves completed observations and refuses to discard incomplete imports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-query-refresh-'));
  try {
    const path = join(dir, 'state.json');
    const plan = queryPlan(input, inventory);
    const binding = { sourceOrigin: plan.sourceOrigin, siteId: site.backendSiteId, siteCode: site.code };
    await atomicJson(path, { binding, phase: 'importing', records: [record('saved')] });
    await assert.rejects(archiveCompletedQuery(path, plan), /FINISH_PENDING_QUERY/);
    const completed = { binding, phase: 'verified', records: [record('saved')] };
    await atomicJson(path, completed);
    await archiveCompletedQuery(path, plan);
    assert.equal(await readJson(path), null);
    const files = await readdir(join(dir, 'query-history'));
    assert.deepEqual(await readJson(join(dir, 'query-history', files[0])), completed);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
