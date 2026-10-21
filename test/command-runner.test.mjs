import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../command-runner.mjs';
import { atomicJson, readJson } from '../runner-state.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const command = { id, mode: 'scraping', site_id: 'pilot', organisation_id: 'org', kind: 'customer.create' };
const customer = { external_id: 'source-1', first_name: 'Test', last_name: 'Person', email: 'test@example.test', observed_at: '2026-10-19T00:00:00Z' };
const baseClient = { siteId: 'pilot', organisationId: 'org', apiUrl: 'http://localhost:4000/api/',
  preflight: async () => ({ writesEnabled: true }), command: async () => ({ command }),
  claim: async () => ({ command, leaseToken: 'lease' }), heartbeat: async () => {},
  result: async () => ({ command: { status: 'succeeded' } }),
};

test('a lost result response never causes a second source submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-command-'));
  try {
    let executions = 0;
    let claims = 0;
    let reports = 0;
    const client = { ...baseClient, claim: async () => { claims++; return baseClient.claim(); }, result: async () => {
      if (++reports === 1) throw new Error('network lost');
      return { command: { status: 'succeeded' } };
    } };
    const adapter = { kinds: ['customer.create'], assertReady: async () => {}, execute: async (_command, controls) => {
      executions++; await controls.beforeSubmit(); return { outcome: 'succeeded', customer };
    } };
    const options = { client, adapter, id, journalDirectory: dir };
    await assert.rejects(runCommand(options), /network lost/);
    assert.equal((await readJson(join(dir, `${id}.json`))).phase, 'result_ready');
    assert.equal((await runCommand(options)).sourceResult.outcome, 'succeeded');
    await runCommand(options);
    assert.equal(executions, 1);
    assert.equal(claims, 1);
    assert.equal(reports, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an error after submit is unknown; an error before submit is not_applied', async () => {
  for (const submitted of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'era-uncertainty-'));
    try {
      let result;
      const adapter = { kinds: ['customer.create'], assertReady: async () => {}, execute: async (_command, controls) => {
        if (submitted) await controls.beforeSubmit();
        throw new Error('page disconnected');
      } };
      await runCommand({ client: { ...baseClient, result: async (_id, _lease, body) => { result = body; return {}; } }, adapter, id, journalDirectory: dir });
      assert.equal(result.outcome, submitted ? 'unknown' : 'not_applied');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('missing adapter and crashed attempt refuse to claim or execute', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-no-replay-'));
  try {
    let claims = 0;
    const client = { ...baseClient, claim: async () => { claims++; } };
    await assert.rejects(runCommand({ client, id, journalDirectory: dir }), /VERIFIED_WRITE_ADAPTER_REQUIRED/);
    await atomicJson(join(dir, `${id}.json`), {
      binding: { apiUrl: client.apiUrl, organisationId: client.organisationId, siteId: client.siteId }, phase: 'submitting',
    });
    await assert.rejects(runCommand({ client, id, journalDirectory: dir }), /COMMAND_RECONCILIATION_REQUIRED/);
    assert.equal(claims, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('heartbeat failure blocks the source submission boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'era-lease-'));
  try {
    let submitted = false;
    const adapter = { kinds: ['customer.create'], assertReady: async () => {}, execute: async (_command, controls) => {
      await controls.beforeSubmit(); submitted = true;
    } };
    const result = await runCommand({ client: { ...baseClient, heartbeat: async () => { throw new Error('lease lost'); } }, adapter, id, journalDirectory: dir });
    assert.equal(submitted, false);
    assert.equal(result.sourceResult.outcome, 'not_applied');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
