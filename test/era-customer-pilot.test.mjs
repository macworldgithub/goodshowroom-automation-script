import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePrivacy, pilotCustomer } from '../era-customer-pilot.mjs';
import { selectSourceSite, discoverSites } from '../era-sites.mjs';

test('source restrictions survive import and positive consent is never guessed', () => {
  assert.deepEqual(sourcePrivacy('NC'), { do_not_contact: true, email: 'denied', sms: 'denied', call: 'denied' });
  assert.equal(sourcePrivacy('E').sms, 'denied');
  assert.equal(sourcePrivacy('E').email, 'unknown');
  assert.equal(sourcePrivacy('NPH').call, 'denied');
  for (const code of ['', 'FC', 'unexpected', 'P', 'NP ']) {
    assert.deepEqual(Object.values(sourcePrivacy(code)).slice(1), ['unknown', 'unknown', 'unknown']);
  }
});

test('companies retain their business identity without fabricating personal names', () => {
  assert.equal(pilotCustomer({ first_name: '', last_name: '', business_phone: '123' }).skipped, 'INCOMPLETE_NAME');
  const company = pilotCustomer({ external_id: 'company-id', company_name: 'Example Company', business_phone: '123' }, '2026-10-19T06:00:00Z');
  assert.equal(company.customer.company_name, 'Example Company');
  assert.equal(company.customer.first_name, '');
  assert.equal(company.customer.last_name, '');
  assert.equal(pilotCustomer({ first_name: 'Sample', last_name: 'Person' }).skipped, 'NO_CONTACT');
  const result = pilotCustomer({ external_id: 'sample-id', first_name: 'Sample', last_name: 'Person', business_email: 'sample@example.test', privacy: 'NC' }, '2026-10-19T06:00:00Z');
  assert.equal(result.customer.email, 'sample@example.test');
  assert.equal(result.customer.privacy.do_not_contact, true);
});

test('the active site can be selected without requiring its missing switcher entry', async () => {
  let checked = false;
  const site = { code: '01', label: '01| Example Site' };
  const header = { name: () => 'applicationHeader', locator: () => ({ innerText: async () => site.label }) };
  const session = { assertAuthenticated: async () => { checked = true; }, page: { frames: () => [header] } };
  assert.equal(await selectSourceSite(session, site), site);
  assert.equal(checked, true);
});

test('discovery retains the active site when eraPower excludes it from the menu', async () => {
  const header = { name: () => 'applicationHeader', locator: () => ({ innerText: async () => '01| Example Site' }) };
  const content = { name: () => 'gutsPage', locator: () => ({ count: async () => 1,
    first: () => ({ waitFor: async () => {} }),
    evaluateAll: async () => [{ code: '02', label: '02| Other Site', selector: '#STORE02' }],
  }) };
  const sites = await discoverSites({ assertAuthenticated: async () => {}, page: { frames: () => [header, content] } });
  assert.deepEqual(sites.map(site => site.code), ['01', '02']);
});
