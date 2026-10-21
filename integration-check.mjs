import { lookup } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openAuthenticatedSession } from './erapower-session.mjs';
import { configuredBackendClient, RunnerError } from './backend-client.mjs';
import { readJson } from './runner-state.mjs';

const known = {
  RUN_BACKEND_CONNECT: 'Run npm run backend:connect and sign in to Good Showroom as ADMIN.',
  BACKEND_HTTP_401: 'Refresh the ADMIN connection with npm run backend:connect.',
  BACKEND_UNREACHABLE: 'Start the Good Showroom backend.',
  SCRAPING_MODE_REQUIRED: 'Restart the backend with INTEGRATION_MODE=scraping.',
  SITE_ADMIN_REQUIRED: 'Use an ADMIN session with access to the selected site.',
  INVALID_SITE_MAPPING: 'Configure an explicit mapped Good Showroom site.',
  AUTH_REQUIRED: 'Complete login and any MFA in the dedicated Chrome window.',
  SOURCE_UNAVAILABLE: 'Restore the eraPower connection before running reads.',
  BROWSER_NOT_RUNNING: 'Run npm run browser:open.',
  SOURCE_DNS_UNRESOLVED: 'Check the eraPower hostname and network connection.',
  SITE_INVENTORY_REQUIRED: 'Run npm run sites:discover after signing in.',
};

function failure(error, fallback) {
  let code = error instanceof RunnerError && Object.hasOwn(known, error.code) ? error.code : fallback;
  if (error?.message?.startsWith('AUTH_REQUIRED:')) code = 'AUTH_REQUIRED';
  if (error?.message?.startsWith('SOURCE_UNAVAILABLE:')) code = 'SOURCE_UNAVAILABLE';
  if (error?.message?.includes('connect ECONNREFUSED 127.0.0.1:')) code = 'BROWSER_NOT_RUNNING';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) code = 'SOURCE_DNS_UNRESOLVED';
  return { state: 'blocked', code, nextStep: known[code] || 'Check local configuration and rerun this check.' };
}

export async function connectionReport(probes) {
  const checks = [];
  for (const probe of probes) {
    try { checks.push({ name: probe.name, state: 'ready', ...await probe.run() }); }
    catch (error) { checks.push({ name: probe.name, ...failure(error, probe.fallback) }); }
  }
  const dns = checks.find(check => check.name === 'source_dns');
  const login = checks.find(check => check.name === 'source_login');
  // Chrome may use its own DNS resolver. A verified authenticated source page
  // is stronger evidence of browser connectivity than the system DNS lookup.
  if (dns?.code === 'SOURCE_DNS_UNRESOLVED' && login?.state === 'ready') {
    dns.state = 'warning';
    dns.code = 'SYSTEM_DNS_UNAVAILABLE_BROWSER_READY';
    dns.nextStep = 'Browser reads can continue through the verified Chrome session; system DNS remains unavailable.';
  }
  return { readyForCustomerImport: checks.every(check => check.state !== 'blocked'), checks };
}

async function main() {
  const report = await connectionReport([
    { name: 'source_dns', fallback: 'SOURCE_CONNECTION_REQUIRED', run: async () => {
      const url = new URL(process.env.ERAPOWER_URL);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_SOURCE');
      await lookup(url.hostname);
    } },
    { name: 'source_login', fallback: 'SOURCE_LOGIN_CONFIGURATION_REQUIRED', run: async () => {
      const session = await openAuthenticatedSession({ timeoutMs: 1000 });
      await session.browser.close();
    } },
    { name: 'backend', fallback: 'BACKEND_CONFIGURATION_REQUIRED', run: async () => {
      const client = await configuredBackendClient();
      const status = await client.preflight();
      return { writesEnabled: status.writesEnabled };
    } },
    { name: 'site_mappings', fallback: 'SITE_MAPPING_CONFIGURATION_REQUIRED', run: async () => {
      const inventory = await readJson(fileURLToPath(new URL('./.auth/era-sites.json', import.meta.url)));
      if (!inventory?.sites?.length || inventory.sourceOrigin !== new URL(process.env.ERAPOWER_URL).origin) throw new RunnerError('SITE_INVENTORY_REQUIRED');
      const discovered = inventory.sites.length;
      const mapped = inventory.sites.filter(site => site.backendSiteId).length;
      return { state: mapped === discovered ? 'ready' : 'blocked', discovered, mapped,
        ...(mapped !== discovered ? { nextStep: 'Complete the explicit backend site mappings.' } : {}) };
    } },
  ]);
  // Connection readiness does not establish complete extraction coverage.
  console.log(JSON.stringify({ event: 'integration_connection_report', ...report,
    customerReadCoverage: 'pilot_sample_only', sourceWriteAdapter: 'not_implemented' }));
  if (!report.readyForCustomerImport) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Connection check failed. Verify local configuration.'); process.exitCode = 1; });
}
