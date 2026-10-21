import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredBackendClient, RunnerError } from './backend-client.mjs';
import { readBrowserCustomers, profileMapping } from './customer-browser.mjs';

function text(value, max, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new RunnerError('INVALID_CUSTOMER_FIELD');
  return value.trim();
}

// Revision hashes change only when source-owned content changes, not on each poll.
export function normalizeCustomer(row, observedAt) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new RunnerError('INVALID_CUSTOMER_RECORD');
  const external_id = text(row.external_id, 200);
  const company_name = text(row.company_name, 200, true);
  const first_name = text(row.first_name, 100, !!company_name) ?? '';
  const last_name = text(row.last_name, 100, !!company_name) ?? '';
  const email = text(row.email, 254, true)?.toLowerCase() ?? null;
  const phone = text(row.phone, 40, true);
  if ((!email && !phone) || (email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email))) throw new RunnerError('INVALID_CUSTOMER_CONTACT');
  // Missing source consent never implies permission to contact the customer.
  const privacy = row.privacy ?? { do_not_contact: false, email: 'unknown', sms: 'unknown', call: 'unknown' };
  if (typeof privacy.do_not_contact !== 'boolean' || ['email', 'sms', 'call'].some(key => !['unknown', 'granted', 'denied'].includes(privacy[key]))) {
    throw new RunnerError('INVALID_CUSTOMER_PRIVACY');
  }
  const owned = { external_id, ...(company_name ? { company_name } : {}), first_name, last_name, email, phone,
    privacy: { do_not_contact: privacy.do_not_contact, email: privacy.email, sms: privacy.sms, call: privacy.call } };
  const observed_at = observedAt || row.observed_at;
  if (typeof observed_at !== 'string' || !Number.isFinite(Date.parse(observed_at))) throw new RunnerError('OBSERVATION_TIME_REQUIRED');
  return { ...owned, revision: createHash('sha256').update(JSON.stringify(owned)).digest('hex'), observed_at: new Date(observed_at).toISOString() };
}

export function normalizeBatch(rows, observedAt) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new RunnerError('INVALID_CUSTOMER_BATCH');
  const records = rows.map(row => normalizeCustomer(row, observedAt));
  if (new Set(records.map(row => row.external_id)).size !== records.length) throw new RunnerError('DUPLICATE_SOURCE_IDS');
  return records;
}

export async function importBatches(client, records, { startOffset = 0, onBatch = async () => {} } = {}) {
  if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset > records.length || (startOffset !== records.length && startOffset % 100 !== 0)) throw new RunnerError('INVALID_IMPORT_OFFSET');
  let imported = startOffset;
  for (let offset = startOffset; offset < records.length; offset += 100) {
    await client.importCustomers(records.slice(offset, offset + 100));
    imported += Math.min(100, records.length - offset);
    await onBatch(imported);
    console.log(JSON.stringify({ event: 'customer_batch_imported', imported }));
  }
  return imported;
}

async function main() {
  const command = process.argv[2];
  const client = await configuredBackendClient();
  await client.preflight();
  if (command === 'preflight') { console.log('Backend scraping mode and ADMIN site access verified.'); return; }
  let records;
  if (command === 'import-file') {
    // Operator-reviewed normalized observations, not arbitrary downloaded pages.
    const envelope = JSON.parse(await readFile(resolve(process.argv[3]), 'utf8'));
    if (envelope.siteId !== client.siteId || envelope.sourceOrigin !== new URL(process.env.ERAPOWER_URL).origin) throw new RunnerError('IMPORT_SOURCE_MISMATCH');
    records = normalizeBatch(envelope.customers);
  } else if (command === 'read') {
    const profile = JSON.parse(await readFile(new URL('./.auth/customer-profile.json', import.meta.url), 'utf8'));
    records = normalizeBatch(await readBrowserCustomers(profileMapping(profile), { show: process.argv.includes('--show') }));
  } else throw new RunnerError('USE_PREFLIGHT_IMPORT_FILE_OR_READ');
  // Read is a preview by default: only --apply performs backend imports.
  if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ event: 'customer_preview', count: records.length, applied: false })); return; }
  await importBatches(client, records);
  console.log(JSON.stringify({ event: 'customer_sync_complete', count: records.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'customer_sync_failed', code: error instanceof RunnerError ? error.code : 'CHECK_SESSION_PROFILE_AND_CONFIGURATION' }));
    process.exitCode = 1;
  });
}
