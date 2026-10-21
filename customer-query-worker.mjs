import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { readJson, atomicJson, exclusiveRun } from './runner-state.mjs';
import { configuredBackendClient, RunnerError, safeRunnerCode } from './backend-client.mjs';
import { readCustomerQuery } from './era-customer-pilot.mjs';
import { normalizeBatch, importBatches } from './customer-sync.mjs';

const directory = fileURLToPath(new URL('./.auth/', import.meta.url));

export function queryPlan(value, inventory) {
  if (value?.version !== 1 || value.coverage !== 'filtered_query_set' || !Array.isArray(value.queries) ||
      value.queries.length < 1 || value.queries.length > 100 || value.sourceOrigin !== inventory?.sourceOrigin) throw new RunnerError('INVALID_CUSTOMER_QUERY_PLAN');
  const site = inventory.sites?.find(site => site.code === value.siteCode);
  if (!site?.backendSiteId || !/^\d+$/.test(site.code)) throw new RunnerError('MAPPED_SOURCE_SITE_REQUIRED');
  const queries = value.queries.map(query => {
    if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 80) throw new RunnerError('INVALID_CUSTOMER_QUERY');
    return query.trim();
  });
  if (new Set(queries.map(query => query.toLocaleUpperCase())).size !== queries.length) throw new RunnerError('DUPLICATE_CUSTOMER_QUERY');
  const maxRecordsPerQuery = value.maxRecordsPerQuery ?? 1000;
  if (!Number.isInteger(maxRecordsPerQuery) || maxRecordsPerQuery < 1 || maxRecordsPerQuery > 1000) throw new RunnerError('INVALID_CUSTOMER_QUERY_LIMIT');
  return { version: 1, site, sourceOrigin: value.sourceOrigin, queries, maxRecordsPerQuery, coverage: 'filtered_query_set' };
}

export function mergeObservations(existing, incoming) {
  const byId = new Map(normalizeBatch(existing).map(record => [record.external_id, record]));
  for (const record of normalizeBatch(incoming)) {
    const previous = byId.get(record.external_id);
    if (previous?.observed_at === record.observed_at && previous.revision !== record.revision) throw new RunnerError('CONFLICTING_QUERY_OBSERVATIONS');
    if (!previous || previous.observed_at <= record.observed_at) byId.set(record.external_id, record);
  }
  if (byId.size > 10000) throw new RunnerError('CUSTOMER_PLAN_RECORD_LIMIT_EXCEEDED');
  return [...byId.values()];
}

export async function archiveCompletedQuery(statePath, plan) {
  const state = await readJson(statePath);
  if (!state) return;
  if (!['read_complete', 'verified'].includes(state.phase)) throw new RunnerError('FINISH_PENDING_QUERY_BEFORE_REFRESH');
  if (state.binding?.sourceOrigin !== plan.sourceOrigin || state.binding.siteId !== plan.site.backendSiteId || state.binding.siteCode !== plan.site.code) throw new RunnerError('QUERY_REFRESH_SITE_MISMATCH');
  const history = join(dirname(statePath), 'query-history');
  await mkdir(history, { recursive: true, mode: 0o700 });
  await rename(statePath, join(history, `${Date.now()}-${process.pid}-${basename(statePath)}`));
}

export async function runQueryPlan({ plan, statePath, client, apply = false, read = readCustomerQuery, signal }) {
  const binding = { sourceOrigin: plan.sourceOrigin, siteId: plan.site.backendSiteId, siteCode: plan.site.code,
    planHash: createHash('sha256').update(JSON.stringify({ queries: plan.queries, limit: plan.maxRecordsPerQuery })).digest('hex') };
  if (apply) {
    if (!client || client.siteId !== binding.siteId) throw new RunnerError('QUERY_IMPORT_SITE_MISMATCH');
    await client.preflight();
  }
  let state = await readJson(statePath);
  if (state && JSON.stringify(state.binding) !== JSON.stringify(binding)) throw new RunnerError('QUERY_CHECKPOINT_PLAN_MISMATCH');
  if (!state) state = { version: 1, binding, completedQueries: 0, records: [], querySummaries: [], offset: 0, phase: 'reading' };
  state.records = normalizeBatch(state.records);
  if (state.version !== 1 || !Number.isInteger(state.completedQueries) || state.completedQueries < 0 || state.completedQueries > plan.queries.length ||
      !['reading', 'read_complete', 'importing', 'verified'].includes(state.phase) || !Array.isArray(state.querySummaries) ||
      state.querySummaries.length !== state.completedQueries) throw new RunnerError('INVALID_QUERY_CHECKPOINT');
  await atomicJson(statePath, state);
  while (state.completedQueries < plan.queries.length) {
    signal?.throwIfAborted();
    if (state.activeQuery && (state.activeQuery.index !== state.completedQueries || !Array.isArray(state.activeQuery.items))) throw new RunnerError('INVALID_ACTIVE_QUERY_CHECKPOINT');
    state.activeQuery ||= { index: state.completedQueries, items: [] };
    const result = await read({ site: plan.site, query: plan.queries[state.completedQueries], maxRecords: plan.maxRecordsPerQuery,
      completed: state.activeQuery.items,
      signal,
      onRecord: async item => {
        if (state.activeQuery.items.some(previous => previous.id === item.id)) throw new RunnerError('DUPLICATE_QUERY_PROGRESS');
        state.activeQuery.items.push(item);
        await atomicJson(statePath, state);
      },
    });
    if (result.coverage !== 'filtered_query_pages' || !Number.isInteger(result.selected) || result.selected < result.records.length || result.selected > plan.maxRecordsPerQuery) throw new RunnerError('INCOMPLETE_QUERY_RESULT');
    state.records = mergeObservations(state.records, result.records);
    state.querySummaries.push({ selected: result.selected, valid: result.records.length, skipped: result.skipped });
    state.completedQueries++;
    delete state.activeQuery;
    state.phase = state.completedQueries === plan.queries.length ? 'read_complete' : 'reading';
    await atomicJson(statePath, state);
    console.log(JSON.stringify({ event: 'customer_query_checkpoint', completedQueries: state.completedQueries, totalQueries: plan.queries.length, uniqueRecords: state.records.length, coverage: plan.coverage }));
  }
  if (!apply) return { records: state.records.length, completedQueries: state.completedQueries, coverage: plan.coverage, applied: false };
  const importBinding = { apiUrl: client.apiUrl, organisationId: client.organisationId, siteId: client.siteId };
  if (state.importBinding && JSON.stringify(state.importBinding) !== JSON.stringify(importBinding)) throw new RunnerError('QUERY_IMPORT_BACKEND_MISMATCH');
  state.importBinding = importBinding;
  state.phase = 'importing';
  await atomicJson(statePath, state);
  await importBatches(client, state.records, { startOffset: state.offset, onBatch: async offset => {
    state.offset = offset; await atomicJson(statePath, state);
    signal?.throwIfAborted();
  } });
  const verification = state.records.length ? await client.verifyImportedCustomers(state.records) : { verified: 0 };
  state.phase = 'verified';
  state.verifiedAt = new Date().toISOString();
  await atomicJson(statePath, state);
  return { records: state.records.length, verified: verification.verified, coverage: plan.coverage, applied: true };
}

async function main() {
  const args = process.argv.slice(2);
  const planIndex = args.indexOf('--plan');
  if (planIndex < 0 || !args[planIndex + 1]) throw new RunnerError('CUSTOMER_QUERY_PLAN_REQUIRED');
  const inventory = await readJson(resolve(directory, 'era-sites.json'));
  const plan = queryPlan(await readJson(resolve(args[planIndex + 1])), inventory);
  if (plan.sourceOrigin !== new URL(process.env.ERAPOWER_URL).origin) throw new RunnerError('QUERY_PLAN_SOURCE_MISMATCH');
  const statePath = resolve(directory, `customer-query-${plan.site.code}.json`);
  if (args.includes('--status')) {
    if (args.includes('--refresh')) throw new RunnerError('STATUS_AND_REFRESH_ARE_SEPARATE_OPERATIONS');
    const state = await readJson(statePath);
    console.log(JSON.stringify({ event: 'customer_query_status', phase: state?.phase ?? 'not_started', completedQueries: state?.completedQueries ?? 0,
      totalQueries: plan.queries.length, uniqueRecords: state?.records?.length ?? 0,
      activeQueryRecords: state?.activeQuery?.items?.length ?? 0, coverage: plan.coverage }));
    return;
  }
  const apply = args.includes('--apply');
  const client = apply ? await configuredBackendClient({ GOODSHOWROOM_SITE_ID: plan.site.backendSiteId }) : null;
  const abort = new AbortController();
  const stop = () => abort.abort(new RunnerError('CUSTOMER_QUERY_STOPPED_WITH_CHECKPOINT'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await exclusiveRun(resolve(directory, 'customer-worker.lock'), async () => {
      if (args.includes('--refresh')) await archiveCompletedQuery(statePath, plan);
      const result = await runQueryPlan({ plan, statePath, apply, client, signal: abort.signal });
      console.log(JSON.stringify({ event: 'customer_query_run_complete', ...result }));
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ event: 'customer_query_stopped', code: safeRunnerCode(error) })); process.exitCode = 1; });
}
