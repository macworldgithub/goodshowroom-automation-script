import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionReport } from '../integration-check.mjs';
import { RunnerError } from '../backend-client.mjs';

test('system DNS failure does not block a separately verified live Chrome session', async () => {
  const dns = { name: 'source_dns', fallback: 'DNS_FAILED', run: async () => { throw Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }); } };
  const ready = await connectionReport([dns, { name: 'source_login', run: async () => ({}) }]);
  assert.equal(ready.readyForCustomerImport, true);
  assert.equal(ready.checks[0].state, 'warning');
  const blocked = await connectionReport([dns, { name: 'source_login', fallback: 'AUTH_REQUIRED', run: async () => { throw new Error('login required'); } }]);
  assert.equal(blocked.readyForCustomerImport, false);
  assert.equal(blocked.checks[0].state, 'blocked');
});

test('connection diagnostics continue after failures and never expose raw errors', async () => {
  const report = await connectionReport([
    { name: 'backend', fallback: 'CHECK_CONFIG', run: async () => { throw new RunnerError('SCRAPING_MODE_REQUIRED'); } },
    { name: 'source', fallback: 'CHECK_CONFIG', run: async () => { throw new Error('secret-session-token'); } },
    { name: 'mappings', run: async () => ({ mapped: 25 }) },
  ]);
  assert.equal(report.readyForCustomerImport, false);
  assert.equal(report.checks[0].code, 'SCRAPING_MODE_REQUIRED');
  assert.equal(report.checks[2].mapped, 25);
  assert.equal(JSON.stringify(report).includes('secret-session-token'), false);
});
