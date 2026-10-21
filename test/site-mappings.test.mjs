import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSiteMappings } from '../all-sites-worker.mjs';
import { sessionFromCookies } from '../backend-connect.mjs';
import { matchBackendSite } from '../site-mapping.mjs';

const site = { code: '01', label: '01| Site One', backendSiteId: 'internal-1' };
const origin = 'https://dealer.example';
const profile = { url: `${origin}/app`, sourceSite: site, loaded: '#loaded', rows: '.row',
  site: { selector: '#site', expectedText: site.label },
  fields: { external_id: { selector: '.id' }, first_name: { selector: '.first' }, last_name: { selector: '.last' }, email: { selector: '.email' } } };

test('all-site configuration rejects missing, duplicate and mismatched site mappings before imports', async () => {
  const inventory = { sourceOrigin: origin, sites: [site] };
  const options = { inventory, sourceOrigin: origin, apply: true, loadProfile: async () => profile };
  assert.equal((await loadSiteMappings(options)).length, 1);
  await assert.rejects(loadSiteMappings({ ...options, inventory: { ...inventory, sites: [{ ...site, backendSiteId: null }] } }), /ALL_SITES_REQUIRE_BACKEND_MAPPING/);
  await assert.rejects(loadSiteMappings({ ...options, inventory: { ...inventory, sites: [site, { ...site, code: '02' }] } }), /BACKEND_SITE_MAPPING_MUST_BE_UNIQUE/);
  await assert.rejects(loadSiteMappings({ ...options, loadProfile: async () => ({ ...profile, sourceSite: { ...site, code: '02' } }) }), /CUSTOMER_PROFILE_SITE_MISMATCH/);
});

test('read only the requested Supabase session and reassemble contiguous cookie chunks', () => {
  const name = 'sb-pilot-auth-token';
  const encoded = `base64-${Buffer.from(JSON.stringify({ access_token: 'synthetic-token' })).toString('base64url')}`;
  const cookies = [{ name: `${name}.1`, value: encoded.slice(15) }, { name: `${name}.0`, value: encoded.slice(0, 15) }, { name: 'sb-other-auth-token', value: 'unrelated' }];
  assert.equal(sessionFromCookies(cookies, name).access_token, 'synthetic-token');
  assert.equal(sessionFromCookies(cookies.slice(0, 1), name), null);
  assert.equal(sessionFromCookies(cookies, 'sb-unknown-auth-token'), null);
  assert.equal(sessionFromCookies([{ name, value: 'not-json' }], name), null);
});

test('site mapping matches exact names and refuses ambiguous or vanished mappings', () => {
  const backend = [{ id: 'internal-1', name: 'Site One' }];
  assert.equal(matchBackendSite({ ...site, backendSiteId: null }, backend).id, 'internal-1');
  assert.throws(() => matchBackendSite(site, []), /MAPPED_BACKEND_SITE_UNAVAILABLE/);
  assert.throws(() => matchBackendSite({ ...site, backendSiteId: null }, [...backend, { id: 'another', name: '01| Site One' }]), /BACKEND_SITE_NAME_AMBIGUOUS/);
});
