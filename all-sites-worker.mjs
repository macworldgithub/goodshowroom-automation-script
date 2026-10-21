import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, exclusiveRun } from './runner-state.mjs';
import { configuredBackendClient, RunnerError } from './backend-client.mjs';
import { validateCustomerProfile } from './customer-browser.mjs';
import { syncCycle } from './customer-worker.mjs';

const authDirectory = fileURLToPath(new URL('./.auth/', import.meta.url));

export async function loadSiteMappings({ inventory, loadProfile, apply, sourceOrigin }) {
  if (!inventory?.sites?.length || inventory.sourceOrigin !== sourceOrigin) throw new RunnerError('SOURCE_SITE_INVENTORY_REQUIRED');
  const mappedIds = new Set();
  const codes = new Set();
  const prepared = [];
  for (const site of inventory.sites) {
    if (!/^\d+$/.test(site.code) || codes.has(site.code)) throw new RunnerError('INVALID_SOURCE_SITE_INVENTORY');
    codes.add(site.code);
    if (apply && !site.backendSiteId) throw new RunnerError('ALL_SITES_REQUIRE_BACKEND_MAPPING');
    if (site.backendSiteId && mappedIds.has(site.backendSiteId)) throw new RunnerError('BACKEND_SITE_MAPPING_MUST_BE_UNIQUE');
    if (site.backendSiteId) mappedIds.add(site.backendSiteId);
    const profile = await loadProfile(site.code);
    validateCustomerProfile(profile);
    if (profile.sourceSite?.code !== site.code || profile.sourceSite?.label !== site.label || profile.site.expectedText !== site.label || new URL(profile.url).origin !== sourceOrigin) throw new RunnerError('CUSTOMER_PROFILE_SITE_MISMATCH');
    prepared.push({ site, profile });
  }
  return prepared;
}

async function main() {
  const inventory = await readJson(resolve(authDirectory, 'era-sites.json'));
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({ event: 'site_mapping_status', discovered: inventory?.sites?.length ?? 0,
      mapped: inventory?.sites?.filter(site => site.backendSiteId).length ?? 0 }));
    return;
  }
  const sourceOrigin = new URL(process.env.ERAPOWER_URL).origin;
  const apply = process.argv.includes('--apply');
  const prepared = await loadSiteMappings({ inventory, apply, sourceOrigin,
    loadProfile: async code => JSON.parse(await readFile(resolve(authDirectory, 'sites', code, 'customer-profile.json'), 'utf8')) });
  // Validate the complete map before importing anything. Never silently skip sites.
  await exclusiveRun(resolve(authDirectory, 'all-sites-worker.lock'), async () => {
    for (const { site, profile } of prepared) {
      const client = await configuredBackendClient({ GOODSHOWROOM_SITE_ID: site.backendSiteId });
      console.log(JSON.stringify({ event: 'site_customer_sync_start', sourceSiteCode: site.code }));
      await syncCycle({ client, mapping: profile, sourceOrigin,
        checkpointPath: resolve(authDirectory, 'sites', site.code, 'customer-import.json'), apply,
        show: process.argv.includes('--show') });
    }
    console.log(JSON.stringify({ event: 'all_sites_sync_complete', sites: prepared.length, applied: apply }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'all_sites_sync_stopped', code: error instanceof RunnerError ? error.code : 'CHECK_SITE_PROFILES_AND_SESSION' }));
    process.exitCode = 1;
  });
}
