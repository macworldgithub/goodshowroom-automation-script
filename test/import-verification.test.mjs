import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendClient } from '../backend-client.mjs';

const siteId = '00000000-0000-4000-8000-000000000001';
const organisationId = '00000000-0000-4000-8000-000000000002';
const expected = { external_id: 'company-1', company_name: 'Example Company', first_name: '', last_name: '', email: 'example@example.test', phone: null, revision: '1', privacy: { do_not_contact: true, email: 'denied', sms: 'denied', call: 'denied' } };
const customer = { ...expected, site_id: siteId, source: 'pentana', integration_mode: 'scraping', external_ids: { pentana: expected.external_id }, source_revision: '1' };
const client = send => createBackendClient({ GOODSHOWROOM_API_URL: 'http://localhost:4000/api/', GOODSHOWROOM_SITE_ID: siteId, GOODSHOWROOM_ORGANISATION_ID: organisationId, GOODSHOWROOM_ACCESS_TOKEN: 'test-token' }, send);

test('post-import verification follows pages and checks source identity, company and privacy', async () => {
  let calls = 0;
  const api = client(async url => {
    assert.equal(url.searchParams.get('siteId'), siteId);
    calls++;
    return Response.json({ customers: calls === 1 ? [] : [customer], integration: { mode: 'scraping' }, pagination: { hasMore: calls === 1, nextOffset: 100 } });
  });
  assert.deepEqual(await api.verifyImportedCustomers([expected]), { verified: 1 });
  assert.equal(calls, 2);
});

test('post-import verification rejects missing records, dropped companies, and changed consent', async () => {
  for (const row of [{ ...customer, company_name: undefined }, { ...customer, site_id: organisationId }, { ...customer, privacy: { ...customer.privacy, email: 'granted' } }]) {
    const api = client(async () => Response.json({ customers: [row], integration: { mode: 'scraping' } }));
    await assert.rejects(api.verifyImportedCustomers([expected]), /IMPORTED_CUSTOMER_MISMATCH/);
  }
  await assert.rejects(client(async () => Response.json({ customers: [], integration: { mode: 'scraping' } })).verifyImportedCustomers([expected]), /IMPORTED_CUSTOMER_NOT_VISIBLE/);
});
