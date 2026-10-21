import { readFile } from 'node:fs/promises';

export class RunnerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function safeRunnerCode(error) {
  if (error instanceof RunnerError) return error.code;
  if (error?.message?.startsWith('SOURCE_UNAVAILABLE:')) return 'SOURCE_UNAVAILABLE';
  if (error?.message?.startsWith('AUTH_REQUIRED:')) return 'AUTH_REQUIRED';
  return 'CHECK_SESSION_AND_SOURCE_MAPPING';
}

export async function configuredBackendClient(overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (!env.GOODSHOWROOM_ACCESS_TOKEN) {
    let session;
    try { session = JSON.parse(await readFile(new URL('./.auth/backend-session.json', import.meta.url), 'utf8')); }
    catch { throw new RunnerError('RUN_BACKEND_CONNECT'); }
    const configuredUrl = new URL(env.GOODSHOWROOM_API_URL || 'http://localhost:4000/api/');
    if (!configuredUrl.pathname.endsWith('/')) configuredUrl.pathname += '/';
    if (session.apiUrl !== configuredUrl.href) throw new RunnerError('BACKEND_SESSION_ORIGIN_MISMATCH');
    env.GOODSHOWROOM_ACCESS_TOKEN = session.accessToken;
    env.GOODSHOWROOM_ORGANISATION_ID ||= session.organisationId;
    if (!env.GOODSHOWROOM_SITE_ID && session.sites?.length === 1) env.GOODSHOWROOM_SITE_ID = session.sites[0].id;
  }
  return createBackendClient(env);
}

export function createBackendClient(env = process.env, send = fetch) {
  const base = new URL(env.GOODSHOWROOM_API_URL || 'http://localhost:4000/api/');
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    throw new RunnerError('INVALID_BACKEND_URL');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const siteId = env.GOODSHOWROOM_SITE_ID;
  const organisationId = env.GOODSHOWROOM_ORGANISATION_ID;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(siteId || '') || !uuid.test(organisationId || '')) throw new RunnerError('INVALID_SITE_MAPPING');
  const token = env.GOODSHOWROOM_ACCESS_TOKEN?.trim();
  if (!token || /\s/.test(token)) throw new RunnerError('ADMIN_SESSION_REQUIRED');
  async function request(path, body) {
    let response;
    try {
      response = await send(new URL(path, base), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
    } catch { throw new RunnerError('BACKEND_UNREACHABLE'); }
    if (!response.ok) throw new RunnerError(`BACKEND_HTTP_${response.status}`);
    try { return await response.json(); } catch { throw new RunnerError('INVALID_BACKEND_RESPONSE'); }
  }
  const commandPath = id => {
    if (!uuid.test(id || '')) throw new RunnerError('INVALID_COMMAND_ID');
    return `admin/integration/commands/${id}`;
  };
  return {
    siteId,
    organisationId,
    apiUrl: base.href,
    async preflight() {
      const context = await request('auth/me');
      const site = context.sites?.find(item => item.id === siteId && item.organisation_id === organisationId);
      if (!site?.roles?.includes('ADMIN')) throw new RunnerError('SITE_ADMIN_REQUIRED');
      const status = await request('integration/status');
      if (status.mode !== 'scraping') throw new RunnerError('SCRAPING_MODE_REQUIRED');
      return { siteId, mode: status.mode, writesEnabled: status.writesEnabled === true };
    },
    importCustomers(customers) { return request('admin/integration/customers/import', { siteId, customers }); },
    importSourceRead(dataset, read) {
      if (!['stock', 'sales_enquiries', 'deals', 'deliveries', 'appointments', 'repair_orders'].includes(dataset)) throw new RunnerError('INVALID_SOURCE_DATASET');
      return request(`integration/source-reads/${dataset}`, { siteId, read });
    },
    async verifyImportedCustomers(records) {
      const remaining = new Map(records.map(record => [record.external_id, record]));
      let verified = 0;
      for (let offset = 0; offset <= 1000000;) {
        const page = await request(`customers?${new URLSearchParams({ siteId, offset: String(offset), limit: '100' })}`);
        if (!Array.isArray(page.customers) || page.integration?.mode !== 'scraping') throw new RunnerError('INVALID_BACKEND_RESPONSE');
        for (const customer of page.customers) {
          const externalId = customer.external_ids?.pentana;
          const expected = remaining.get(externalId);
          if (!expected) continue;
          if (customer.site_id !== siteId || customer.source !== 'pentana' || customer.integration_mode !== 'scraping' ||
              ['first_name', 'last_name', 'email', 'phone'].some(field => customer[field] !== expected[field]) ||
              (customer.company_name || null) !== (expected.company_name || null) ||
              customer.source_revision !== expected.revision ||
              ['do_not_contact', 'email', 'sms', 'call'].some(field => customer.privacy?.[field] !== expected.privacy?.[field])) {
            throw new RunnerError('IMPORTED_CUSTOMER_MISMATCH');
          }
          verified++;
          remaining.delete(externalId);
        }
        if (!remaining.size) return { verified };
        if (!page.pagination?.hasMore) break;
        if (!Number.isInteger(page.pagination.nextOffset) || page.pagination.nextOffset <= offset) throw new RunnerError('INVALID_BACKEND_PAGINATION');
        offset = page.pagination.nextOffset;
      }
      throw new RunnerError('IMPORTED_CUSTOMER_NOT_VISIBLE');
    },
    async adminSites() {
      const sites = [];
      for (let offset = 0; offset <= 1000000;) {
        const page = await request(`admin/sites?${new URLSearchParams({ organisationId, offset: String(offset), limit: '100' })}`);
        if (!Array.isArray(page.sites)) throw new RunnerError('INVALID_BACKEND_RESPONSE');
        sites.push(...page.sites);
        if (!page.pagination?.hasMore) return sites;
        if (!Number.isInteger(page.pagination.nextOffset) || page.pagination.nextOffset <= offset) throw new RunnerError('INVALID_BACKEND_PAGINATION');
        offset = page.pagination.nextOffset;
      }
      throw new RunnerError('BACKEND_SITE_LIMIT_EXCEEDED');
    },
    createSite(name) {
      return request('admin/sites', { organisationId, name, timezone: env.ERAPOWER_TIMEZONE || 'Australia/Melbourne', brandIds: [] });
    },
    command(id) {
      commandPath(id);
      return request(`integration/commands/${id}`);
    },
    claim(id) { return request(`${commandPath(id)}/claim`, {}); },
    heartbeat(id, leaseToken) { return request(`${commandPath(id)}/heartbeat`, { leaseToken }); },
    result(id, leaseToken, result) { return request(`${commandPath(id)}/result`, { ...result, leaseToken }); },
    async pendingCommands() {
      const commands = [];
      for (const status of ['queued', 'retry_wait']) {
        for (let offset = 0; offset <= 1000000;) {
          const page = await request(`admin/integration/commands?${new URLSearchParams({ organisationId, status, offset: String(offset), limit: '100' })}`);
          if (!Array.isArray(page.commands)) throw new RunnerError('INVALID_BACKEND_RESPONSE');
          commands.push(...page.commands.filter(command => command.mode === 'scraping' && command.site_id === siteId && command.organisation_id === organisationId && Date.parse(command.available_at) <= Date.now()));
          if (!page.pagination?.hasMore) break;
          if (!Number.isInteger(page.pagination.nextOffset) || page.pagination.nextOffset <= offset) throw new RunnerError('INVALID_BACKEND_PAGINATION');
          offset = page.pagination.nextOffset;
        }
      }
      return commands;
    },
  };
}
