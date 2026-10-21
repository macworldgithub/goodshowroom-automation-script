import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredBackendClient, RunnerError } from './backend-client.mjs';
import { atomicJson, exclusiveRun, readJson } from './runner-state.mjs';

const normalizedName = value => value.replace(/\s+/g, ' ').trim().toLowerCase();

export function matchBackendSite(source, sites) {
  if (source.backendSiteId) {
    const existing = sites.find(site => site.id === source.backendSiteId);
    if (!existing) throw new RunnerError('MAPPED_BACKEND_SITE_UNAVAILABLE');
    return existing;
  }
  const labels = [source.label, source.label.replace(/^\d+\|\s*/, '')].map(normalizedName);
  const matches = sites.filter(site => labels.includes(normalizedName(site.name)));
  if (matches.length > 1) throw new RunnerError('BACKEND_SITE_NAME_AMBIGUOUS');
  return matches[0] ?? null;
}

async function main() {
  const directory = fileURLToPath(new URL('./.auth/', import.meta.url));
  const path = resolve(directory, 'era-sites.json');
  const apply = process.argv.includes('--apply');
  const create = process.argv.includes('--create');
  if (create && !apply) throw new RunnerError('SITE_CREATION_REQUIRES_APPLY');
  const inventory = await readJson(path);
  if (!inventory?.sites?.length || inventory.sourceOrigin !== new URL(process.env.ERAPOWER_URL).origin) throw new RunnerError('SOURCE_SITE_INVENTORY_REQUIRED');
  // Site listing checks organisation-wide ADMIN, independently of a selected site.
  const client = await configuredBackendClient({ GOODSHOWROOM_SITE_ID: '00000000-0000-4000-8000-000000000000' });
  await exclusiveRun(resolve(directory, 'site-mapping.lock'), async () => {
    const backendSites = await client.adminSites();
    const pendingPath = resolve(directory, 'site-provisioning.json');
    const pending = await readJson(pendingPath) ?? {};
    let mapped = 0;
    const used = new Set();
    for (const source of inventory.sites) {
      let match = matchBackendSite(source, backendSites);
      if (!match && create) {
        if (pending[source.code]) throw new RunnerError('SITE_CREATION_REVIEW_REQUIRED');
        // A lost response must not silently create another backend site on retry.
        pending[source.code] = { label: source.label, requestedAt: new Date().toISOString() };
        await atomicJson(pendingPath, pending);
        const result = await client.createSite(source.label);
        if (!result.site?.id || result.site.organisation_id !== client.organisationId || result.site.name !== source.label) throw new RunnerError('INVALID_SITE_CREATION_RESPONSE');
        match = result.site;
        backendSites.push(match);
      }
      if (match) {
        if (used.has(match.id)) throw new RunnerError('BACKEND_SITE_MAPPING_MUST_BE_UNIQUE');
        used.add(match.id);
        source.backendSiteId = match.id;
        mapped++;
        if (apply) {
          inventory.organisationId = client.organisationId;
          inventory.apiUrl = client.apiUrl;
          await atomicJson(path, inventory);
          delete pending[source.code];
          await atomicJson(pendingPath, pending);
        }
      }
      console.log(JSON.stringify({ event: 'site_mapping', sourceSiteCode: source.code, status: match ? 'matched' : 'backend_site_required', applied: apply && !!match }));
    }
    console.log(JSON.stringify({ event: 'site_mapping_complete', discovered: inventory.sites.length, matched: mapped, applied: apply }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ event: 'site_mapping_failed', code: error instanceof RunnerError ? error.code : 'CHECK_SOURCE_AND_BACKEND_CONNECTION' })); process.exitCode = 1; });
}
