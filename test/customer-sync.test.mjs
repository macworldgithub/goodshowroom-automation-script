import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBatch, normalizeCustomer, importBatches } from '../customer-sync.mjs';
import { createBackendClient } from '../backend-client.mjs';

const observation = { external_id: 'source-1', first_name: 'Pilot', last_name: 'Customer', email: 'PILOT@example.test', phone: null, observed_at: '2026-10-19T01:00:00Z' };
const env = { GOODSHOWROOM_SITE_ID: '11111111-1111-4111-8111-111111111111', GOODSHOWROOM_ORGANISATION_ID: '22222222-2222-4222-8222-222222222222', GOODSHOWROOM_ACCESS_TOKEN: 'operator-session' };

test('repeated observations preserve revisions and never infer consent', () => {
  const first = normalizeCustomer(observation);
  const later = normalizeCustomer({ ...observation, observed_at: '2026-10-19T02:00:00Z' });
  assert.equal(first.revision, later.revision);
  assert.equal(first.email, 'pilot@example.test');
  assert.deepEqual(first.privacy, { do_not_contact: false, email: 'unknown', sms: 'unknown', call: 'unknown' });
  assert.notEqual(first.revision, normalizeCustomer({ ...observation, phone: '123' }).revision);
});

test('reject invalid or duplicate records before starting imports', () => {
  assert.throws(() => normalizeBatch([observation, observation]), /DUPLICATE_SOURCE_IDS/);
  assert.throws(() => normalizeCustomer({ ...observation, email: null }), /INVALID_CUSTOMER_CONTACT/);
  assert.throws(() => normalizeCustomer({ ...observation, observed_at: undefined }), /OBSERVATION_TIME_REQUIRED/);
  assert.throws(() => normalizeCustomer({ ...observation, privacy: { do_not_contact: false, email: 'yes' } }), /INVALID_CUSTOMER_PRIVACY/);
});

test('batch at 100 and stop after a failed batch without retrying', async () => {
  const sizes = [];
  const rows = Array.from({ length: 201 }, (_, i) => ({ ...observation, external_id: String(i) }));
  const client = { async importCustomers(batch) { sizes.push(batch.length); if (sizes.length === 2) throw new Error('unavailable'); } };
  await assert.rejects(importBatches(client, rows), /unavailable/);
  assert.deepEqual(sizes, [100, 100]);
});

test('require mapped ADMIN access and scraping mode', async () => {
  let calls = 0;
  const send = async () => ({ ok: true, json: async () => (++calls === 1 ? { sites: [{ id: env.GOODSHOWROOM_SITE_ID, organisation_id: env.GOODSHOWROOM_ORGANISATION_ID, roles: ['ADMIN'] }] } : { mode: 'simulated' }) });
  await assert.rejects(createBackendClient(env, send).preflight(), /SCRAPING_MODE_REQUIRED/);
  await assert.rejects(createBackendClient(env, async () => ({ ok: true, json: async () => ({ sites: [] }) })).preflight(), /SITE_ADMIN_REQUIRED/);
});

test('do not send access tokens over insecure remote connections or follow redirects', async () => {
  assert.throws(() => createBackendClient({ ...env, GOODSHOWROOM_API_URL: 'http://remote.example/api' }), /INVALID_BACKEND_URL/);
  let options;
  const client = createBackendClient(env, async (_url, opts) => { options = opts; return { ok: false, status: 401 }; });
  await assert.rejects(client.preflight(), /BACKEND_HTTP_401/);
  assert.equal(options.redirect, 'error');
});
