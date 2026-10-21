import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { configuredBackendClient, RunnerError, safeRunnerCode } from './backend-client.mjs';
import { normalizeBatch, importBatches } from './customer-sync.mjs';
import { profileMapping, readBrowserCustomers } from './customer-browser.mjs';
import { atomicJson, readJson, exclusiveRun } from './runner-state.mjs';

const directory = fileURLToPath(new URL('./.auth/', import.meta.url));
const emit = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));

export async function syncCycle({ client, mapping, sourceOrigin, checkpointPath, apply = false, show = false, read = readBrowserCustomers }) {
  await client.preflight();
  const binding = { apiUrl: client.apiUrl, organisationId: client.organisationId, siteId: client.siteId, sourceOrigin };
  let checkpoint = await readJson(checkpointPath);
  if (checkpoint && JSON.stringify(checkpoint.binding) !== JSON.stringify(binding)) throw new RunnerError('CHECKPOINT_SITE_MISMATCH');
  if (checkpoint) {
    if (!apply) throw new RunnerError('PENDING_IMPORT_USE_APPLY_TO_RESUME');
    checkpoint.records = normalizeBatch(checkpoint.records);
    if (!Number.isInteger(checkpoint.offset) || checkpoint.offset < 0 || checkpoint.offset > checkpoint.records.length) throw new RunnerError('INVALID_IMPORT_OFFSET');
    emit({ event: 'customer_import_resuming', completed: checkpoint.offset, total: checkpoint.records.length });
  } else {
    const records = normalizeBatch(await read(profileMapping(mapping), { show }));
    emit({ event: 'customer_read_complete', count: records.length, applied: false });
    if (!apply) return { count: records.length, applied: false };
    checkpoint = { binding, records, offset: 0, observedAt: new Date().toISOString() };
    await atomicJson(checkpointPath, checkpoint);
  }
  await importBatches(client, checkpoint.records, {
    startOffset: checkpoint.offset,
    onBatch: async offset => { checkpoint.offset = offset; await atomicJson(checkpointPath, checkpoint); },
  });
  await unlink(checkpointPath);
  emit({ event: 'customer_sync_complete', count: checkpoint.records.length, applied: true });
  return { count: checkpoint.records.length, applied: true };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const once = process.argv.includes('--once');
  if (!once && !apply) throw new RunnerError('SCHEDULED_IMPORT_REQUIRES_APPLY');
  const interval = Number(process.env.GOODSHOWROOM_SYNC_INTERVAL_SECONDS || 300);
  if (!Number.isInteger(interval) || interval < 30 || interval > 3600) throw new RunnerError('SYNC_INTERVAL_MUST_BE_30_TO_3600_SECONDS');
  const client = await configuredBackendClient();
  const mapping = JSON.parse(await readFile(resolve(directory, 'customer-profile.json'), 'utf8'));
  const source = new URL(process.env.ERAPOWER_URL);
  if (new URL(mapping.url).origin !== source.origin) throw new RunnerError('EXTRACTION_ORIGIN_MISMATCH');
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await exclusiveRun(resolve(directory, 'customer-worker.lock'), async () => {
      do {
        try {
          const result = await syncCycle({ client, mapping, sourceOrigin: source.origin,
            checkpointPath: resolve(directory, 'customer-import.json'), apply, show: process.argv.includes('--show') });
          await atomicJson(resolve(directory, 'worker-status.json'), { state: 'ready', lastSuccess: new Date().toISOString(), ...result });
        } catch (error) {
          const code = safeRunnerCode(error);
          await atomicJson(resolve(directory, 'worker-status.json'), { state: 'stopped', code, at: new Date().toISOString() });
          emit({ event: 'customer_worker_stopped', code });
          throw new RunnerError(code);
        }
        if (once) break;
        emit({ event: 'customer_worker_waiting', nextReadInSeconds: interval });
        for (let seconds = 0; seconds < interval && !stopped; seconds++) await new Promise(done => setTimeout(done, 1000));
      } while (!stopped);
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { emit({ event: 'worker_failed', code: error instanceof RunnerError ? error.code : 'CHECK_CONFIGURATION' }); process.exitCode = 1; });
}
