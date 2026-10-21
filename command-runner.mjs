import { join } from 'node:path';
import { atomicJson, exclusiveRun, readJson } from './runner-state.mjs';
import { RunnerError } from './backend-client.mjs';
import { normalizeCustomer } from './customer-sync.mjs';

const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unknown = () => ({ outcome: 'unknown', code: 'SOURCE_RESULT_UNVERIFIED', message: 'Source submission may have occurred. Verify eraPower before retrying.' });

// The eraPower adapter must implement assertReady() and execute(command, controls).
// It MUST call controls.beforeSubmit() immediately before the first source mutation,
// check expected_revision for updates, and return a reread normalized customer.
// No adapter is registered until its live form and read-back have been verified.
export async function runCommand({ client, adapter, id, journalDirectory, heartbeatMs = 60000 }) {
  if (!idPattern.test(id)) throw new RunnerError('INVALID_COMMAND_ID');
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60000) throw new RunnerError('INVALID_HEARTBEAT_INTERVAL');
  const path = join(journalDirectory, `${id}.json`);
  return exclusiveRun(`${path}.lock`, async () => {
    const status = await client.preflight();
    const binding = { apiUrl: client.apiUrl, organisationId: client.organisationId, siteId: client.siteId };
    let journal = await readJson(path);
    if (journal && JSON.stringify(journal.binding) !== JSON.stringify(binding)) throw new RunnerError('COMMAND_JOURNAL_SITE_MISMATCH');
    if (journal?.phase === 'reported') return { sourceResult: journal.result, backendStatus: journal.backendStatus };
    if (journal && !journal.result) throw new RunnerError('COMMAND_RECONCILIATION_REQUIRED');
    if (!journal) {
      if (!status.writesEnabled) throw new RunnerError('BACKEND_WRITES_DISABLED');
      if (!adapter?.assertReady || !adapter?.execute || !Array.isArray(adapter.kinds)) throw new RunnerError('VERIFIED_WRITE_ADAPTER_REQUIRED');
      const visible = (await client.command(id)).command;
      if (visible?.mode !== 'scraping' || visible.site_id !== client.siteId || visible.organisation_id !== client.organisationId || !adapter.kinds.includes(visible.kind)) throw new RunnerError('COMMAND_OUTSIDE_ADAPTER_SCOPE');
      await adapter.assertReady(visible);
      // Persist before claiming: a crash must never silently replay an ambiguous attempt.
      journal = { binding, commandId: id, phase: 'claiming', updatedAt: new Date().toISOString() };
      await atomicJson(path, journal);
      const claim = await client.claim(id);
      if (!claim.leaseToken || claim.command?.id !== id || claim.command.mode !== 'scraping' || claim.command.site_id !== client.siteId || claim.command.organisation_id !== client.organisationId) throw new RunnerError('INVALID_CLAIM_RESPONSE');
      journal.leaseToken = claim.leaseToken;
      journal.phase = 'claimed';
      await atomicJson(path, journal);
      const abort = new AbortController();
      let submitted = false;
      let renewing = Promise.resolve();
      const heartbeat = async () => {
        if (abort.signal.aborted) throw new RunnerError('LEASE_RENEWAL_FAILED');
        try { await client.heartbeat(id, journal.leaseToken); }
        catch { abort.abort(); throw new RunnerError('LEASE_RENEWAL_FAILED'); }
      };
      const timer = setInterval(() => {
        renewing = renewing.then(heartbeat).catch(() => { abort.abort(); });
      }, heartbeatMs);
      try {
        const result = await adapter.execute(claim.command, {
          signal: abort.signal,
          beforeSubmit: async () => {
            if (submitted) throw new RunnerError('SECOND_SUBMISSION_FORBIDDEN');
            await heartbeat();
            // Set this before persisting: a journal failure is treated conservatively.
            submitted = true;
            journal.phase = 'submitting';
            await atomicJson(path, journal);
          },
        });
        if (result?.outcome === 'succeeded' && submitted) {
          journal.result = { outcome: 'succeeded', customer: normalizeCustomer(result.customer) };
        } else if (result?.outcome === 'not_applied' && !submitted) {
          journal.result = { outcome: 'not_applied', code: 'SOURCE_NOT_SUBMITTED', message: 'Adapter verified no source submission occurred.' };
        } else if (result?.outcome === 'rejected') {
          journal.result = { outcome: 'rejected', code: 'SOURCE_REJECTED', message: 'The source rejected this operation; review eraPower before preparing a corrected request.' };
        } else journal.result = unknown();
      } catch {
        journal.result = submitted ? unknown() : { outcome: 'not_applied', code: 'SOURCE_NOT_SUBMITTED', message: 'Operation stopped before source submission.' };
      } finally { clearInterval(timer); await renewing; }
      journal.phase = 'result_ready';
      journal.updatedAt = new Date().toISOString();
      await atomicJson(path, journal);
    }
    // If reporting fails, the result stays durable. A rerun reports it only;
    // the adapter and source submission are NEVER repeated.
    const response = await client.result(id, journal.leaseToken, journal.result);
    journal.phase = 'reported';
    journal.backendStatus = response.command?.status ?? null;
    journal.updatedAt = new Date().toISOString();
    await atomicJson(path, journal);
    return { sourceResult: journal.result, backendStatus: journal.backendStatus };
  });
}
