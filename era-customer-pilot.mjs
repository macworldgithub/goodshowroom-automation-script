import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openAuthenticatedSession } from './erapower-session.mjs';
import { selectSourceSite } from './era-sites.mjs';
import { configuredBackendClient, RunnerError, safeRunnerCode } from './backend-client.mjs';
import { normalizeCustomer, normalizeBatch, importBatches } from './customer-sync.mjs';
import { readJson, atomicJson, exclusiveRun } from './runner-state.mjs';
import { pagePosition } from './source-table-reader.mjs';

const directory = fileURLToPath(new URL('./.auth/', import.meta.url));
const emit = value => console.log(JSON.stringify(value));

// These selectors were observed in the authorised live Entity Maintenance UI.
const fields = {
  external_id: '#entityname_entityid', first_name: '#entityname_namefirst',
  last_name: '#entityname_namelast', email: '#entityname_email',
  company_name: '#entityname_NameBusiness',
  business_email: '#entityname_BusinessEmail', mobile: '#entityname_mobile',
  phone: '#entityname_homephone', business_phone: '#entityname_businessphone',
  privacy: '#entityname_privacycode',
};

export function sourcePrivacy(code) {
  // Positive permission needs the dealer's field-ownership/consent sign-off.
  // Preserve explicit restrictions now; never infer permission from an address.
  const result = { do_not_contact: code.trim() === 'NC', email: 'unknown', sms: 'unknown', call: 'unknown' };
  if (result.do_not_contact) return { do_not_contact: true, email: 'denied', sms: 'denied', call: 'denied' };
  const allowed = {
    E: ['email'], EPH: ['email', 'call'], EP: ['email'], ET: ['email', 'sms'],
    PH: ['call'], PHP: ['call'], PHT: ['call', 'sms'], PT: ['sms'], T: ['sms'],
  }[code.trim()];
  if (allowed) for (const channel of ['email', 'sms', 'call']) if (!allowed.includes(channel)) result[channel] = 'denied';
  if (code.trim() === 'NE') result.email = 'denied';
  if (code.trim() === 'NT') result.sms = 'denied';
  if (code.trim() === 'NPH') result.call = 'denied';
  return result;
}

export function pilotCustomer(raw, observedAt) {
  if (!raw.company_name?.trim() && (!raw.first_name?.trim() || !raw.last_name?.trim())) return { skipped: 'INCOMPLETE_NAME' };
  if (![raw.email, raw.business_email, raw.mobile, raw.phone, raw.business_phone].some(value => value?.trim())) return { skipped: 'NO_CONTACT' };
  try {
    return { customer: normalizeCustomer({ ...raw,
      email: raw.email?.trim() || raw.business_email?.trim() || null,
      phone: raw.mobile?.trim() || raw.phone?.trim() || raw.business_phone?.trim() || null,
      privacy: sourcePrivacy(raw.privacy || ''),
    }, observedAt) };
  } catch { return { skipped: 'INVALID_SOURCE_CONTACT_OR_NAME' }; }
}

async function waitUntil(task, code, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await task();
    if (result) return result;
    await new Promise(done => setTimeout(done, 200));
  } while (Date.now() < deadline);
  throw new RunnerError(code);
}

async function matchingFrame(page, name, selector) {
  return waitUntil(async () => {
    const candidates = [];
    for (const frame of page.frames().filter(frame => frame.name() === name)) {
      if (await frame.locator(selector).count().catch(() => 0)) candidates.push(frame);
    }
    if (candidates.length > 1) throw new RunnerError('SOURCE_FRAME_NOT_UNIQUE');
    return candidates[0];
  }, 'SOURCE_SCREEN_NOT_READY');
}

async function actionFrame(page, id, text) {
  return waitUntil(async () => {
    const matches = [];
    for (const frame of page.frames().filter(frame => frame.name() === 'action')) {
      const control = frame.locator(id);
      if (await control.isVisible().catch(() => false) && (await control.innerText()).trim() === text) matches.push(frame);
    }
    if (matches.length > 1) throw new RunnerError('SOURCE_ACTION_NOT_UNIQUE');
    return matches[0];
  }, 'SOURCE_ACTION_CHANGED');
}

async function leaveSearch(session) {
  if (session.page.frames().some(frame => frame.name() === 'guts')) {
    const action = await actionFrame(session.page, '#But4', 'Exit');
    await action.locator('#But4').click();
    await waitUntil(() => !session.page.frames().some(frame => frame.name() === 'guts'), 'SOURCE_SEARCH_DID_NOT_CLOSE');
  }
}

async function entityMenu(session) {
  await leaveSearch(session);
  let frame = await matchingFrame(session.page, 'gutsPage', 'body');
  if (await frame.locator('#entityname_entityid').count()) {
    // This worker only reads source fields; it never clicks Modify or Ok/Save.
    const action = await actionFrame(session.page, '#But10', 'Exit');
    await action.locator('#But10').click();
    frame = await matchingFrame(session.page, 'gutsPage', '#item0');
  }
  if (!await frame.getByText('Entity Maintenance', { exact: true }).count()) throw new RunnerError('OPEN_SOURCE_HOME_MENU');
  return frame;
}

async function openSearch(session, query, site) {
  const menu = await entityMenu(session);
  await menu.getByText('Entity Maintenance', { exact: true }).click();
  const detail = await matchingFrame(session.page, 'gutsPage', '#entityname_entityid');
  await detail.locator('img[src*=SearchIcon]:visible').click();
  const search = await matchingFrame(session.page, 'guts', '#txtSearchName1');
  // Search for customers, rather than silently importing prospects as customers.
  await search.locator('#rdoEntityTypes1').check();
  await search.locator('#txtSearchName1').fill(query);
  await search.locator('#txtSearchName1').press('Tab');
  const action = await actionFrame(session.page, '#But2', 'Find');
  await action.locator('#But2').click();
  await waitUntil(async () => {
    await session.assertAuthenticated();
    await verifySite(session, site);
    if (await sourceMessageVisible(session)) throw new RunnerError('SOURCE_SEARCH_REQUIRES_REFINEMENT_OR_HAS_NO_RESULTS');
    return (await search.locator('#tblEntitySearch input#searchresults_AtbOne').first().inputValue()).trim();
  }, 'SOURCE_SEARCH_EMPTY_OR_UNREADY');
  return search;
}

async function sourceMessageVisible(session) {
  return (await Promise.all(session.page.frames().map(frame => frame.locator('#messageText').isVisible().catch(() => false)))).some(Boolean);
}

async function verifySite(session, site) {
  const header = await matchingFrame(session.page, 'applicationHeader', '#EntityMenu');
  const label = (await header.locator('#EntityMenu').innerText()).replace(/\s+/g, ' ').trim();
  if (![site.label, site.label.replace(/^\d+\|\s*/, '')].includes(label)) throw new RunnerError('SOURCE_SITE_MISMATCH');
}

export async function readPilot(options) {
  const limit = options.limit ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 9) throw new RunnerError('PILOT_REQUIRES_QUERY_AND_LIMIT_1_TO_9');
  return readSelection({ ...options, limit, allPages: false });
}

// All pages within a named query, never a claim of complete dealership coverage.
export async function readCustomerQuery({ site, query, maxRecords = 1000, completed = [], onRecord = async () => {}, signal }) {
  return readSelection({ site, query, limit: maxRecords, allPages: true, completed, onRecord, signal });
}

export async function inspectCustomerQuery({ site, query, maxRecords = 1000 }) {
  return exclusiveRun(resolve(directory, 'browser-worker.lock'), async () => {
    const session = await openAuthenticatedSession();
    try {
      session.page.setDefaultTimeout(15000);
      await selectSourceSite(session, site);
      const search = await openSearch(session, query, site);
      const entries = await collectQueryPages({ maxRecords,
        readPage: () => customerPage(session, search, site),
        nextPage: expected => nextCustomerPage(session, search, site, expected),
      });
      await entityMenu(session);
      return { entries, coverage: 'filtered_query_pages' };
    } finally { await session.browser.close(); }
  });
}

export async function collectQueryPages({ readPage, nextPage, maxRecords = 1000 }) {
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 1000) throw new RunnerError('CUSTOMER_QUERY_LIMIT_MUST_BE_1_TO_1000');
  const selected = []; const seen = new Set(); let total;
  for (let page = 1; ; page++) {
    const current = await readPage();
    if (!Number.isInteger(current.position?.total) || current.position.total < 1 || current.position.total > 1000) throw new RunnerError('UNVERIFIED_SOURCE_PAGINATION');
    if (total === undefined) total = current.position.total;
    if (current.position.current !== page || current.position.total !== total) throw new RunnerError('SOURCE_PAGES_CHANGED_DURING_READ');
    if (!current.ids.length || current.ids.some(id => typeof id !== 'string' || !id.trim())) throw new RunnerError('SOURCE_ROW_ID_REQUIRED');
    for (const id of current.ids) {
      if (seen.has(id)) throw new RunnerError('SOURCE_PAGE_REPEATED_OR_DUPLICATE_ID');
      seen.add(id); selected.push({ id, page, pageIds: current.ids });
    }
    if (selected.length > maxRecords) throw new RunnerError('SOURCE_RECORD_LIMIT_EXCEEDED');
    emit({ event: 'customer_query_page_read', page, pages: total, selected: selected.length });
    if (page === total) return selected;
    await nextPage(page + 1);
  }
}

async function customerPage(session, search, site) {
  await session.assertAuthenticated();
  await verifySite(session, site);
  const position = pagePosition(await search.locator('#CurrentPg:visible').innerText());
  const ids = await search.locator('#tblEntitySearch input#searchresults_AtbOne').evaluateAll(inputs => inputs.map(input => input.value.trim()).filter(Boolean));
  return { position, ids };
}

async function nextCustomerPage(session, search, site, expected) {
  await session.assertAuthenticated();
  await verifySite(session, site);
  await search.locator('img[title="Move to next page"]:visible').click();
  await waitUntil(async () => (await customerPage(session, search, site)).position.current === expected, 'SOURCE_PAGE_DID_NOT_ADVANCE');
}

async function openCustomerId(session, site, id) {
  const menu = await entityMenu(session);
  await verifySite(session, site);
  await menu.getByText('Entity Maintenance', { exact: true }).click();
  const detail = await matchingFrame(session.page, 'gutsPage', '#entityname_entityid');
  const field = detail.locator('#entityname_entityid');
  if ((await field.inputValue()).trim()) throw new RunnerError('SOURCE_LOOKUP_NOT_EMPTY');
  // eraPower's identifier lookup needs keyboard events; fill() alone does not
  // trigger its custom field controller. This navigates to an existing entity.
  await field.click();
  await field.pressSequentially(id, { delay: 35 });
  await field.press('Tab');
  await waitUntil(async () => {
    await session.assertAuthenticated();
    if (await sourceMessageVisible(session)) throw new RunnerError('SOURCE_ID_LOOKUP_REJECTED');
    // The verified existing-record lookup disables the identifier after loading.
    return await field.isDisabled() && await field.inputValue() === id;
  }, 'SOURCE_ID_LOOKUP_NOT_CONFIRMED');
  await verifySite(session, site);
  return detail;
}

async function readSelection({ site, query, limit, allPages, completed = [], onRecord = async () => {}, signal }) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 80 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RunnerError('PILOT_REQUIRES_QUERY_AND_LIMIT_1_TO_9');
  }
  return exclusiveRun(resolve(directory, 'browser-worker.lock'), async () => {
    const session = await openAuthenticatedSession();
    try {
      session.page.setDefaultTimeout(15000);
      await selectSourceSite(session, site);
      await entityMenu(session);
      emit({ event: 'pilot_source_site_verified', siteCode: site.code });
      const search = await openSearch(session, query, site);
      const firstIds = await search.locator('#tblEntitySearch input#searchresults_AtbOne').evaluateAll(inputs => inputs.map(input => input.value.trim()).filter(Boolean));
      if (new Set(firstIds).size !== firstIds.length) throw new RunnerError('DUPLICATE_SOURCE_IDS');
      const selected = allPages ? await collectQueryPages({ maxRecords: limit,
        readPage: () => { signal?.throwIfAborted(); return customerPage(session, search, site); },
        nextPage: expected => nextCustomerPage(session, search, site, expected),
      }) : firstIds.slice(0, limit).map(id => ({ id, page: 1, pageIds: firstIds }));
      emit({ event: 'pilot_source_sample_selected', count: selected.length });
      const records = [];
      const skipped = {};
      const done = new Map();
      for (const item of completed) {
        if (!item?.id || done.has(item.id) || !selected.some(entry => entry.id === item.id) ||
            (!item.customer && !['INCOMPLETE_NAME', 'NO_CONTACT', 'INVALID_SOURCE_CONTACT_OR_NAME'].includes(item.skipped))) throw new RunnerError('QUERY_PROGRESS_DOES_NOT_MATCH_SOURCE');
        if (item.customer) {
          const record = normalizeCustomer(item.customer);
          if (record.external_id !== item.id) throw new RunnerError('QUERY_PROGRESS_ID_MISMATCH');
          records.push(record);
        } else skipped[item.skipped] = (skipped[item.skipped] || 0) + 1;
        done.set(item.id, item);
      }
      for (let index = 0; index < selected.length; index++) {
        signal?.throwIfAborted();
        if (done.has(selected[index].id)) continue;
        await session.assertAuthenticated();
        await verifySite(session, site);
        let detail;
        if (allPages) detail = await openCustomerId(session, site, selected[index].id);
        else {
          const currentSearch = index === 0 ? search : await openSearch(session, query, site);
          // Re-searching must still find this exact ID. Never click a row by index.
          const links = currentSearch.locator('#tblEntitySearch input#searchresults_AtbOne');
          const currentIds = await links.evaluateAll(inputs => inputs.map(input => input.value.trim()));
          if (JSON.stringify(currentIds.filter(Boolean)) !== JSON.stringify(selected[index].pageIds)) throw new RunnerError('SOURCE_SEARCH_CHANGED');
          const position = currentIds.indexOf(selected[index].id);
          if (position < 0 || currentIds.lastIndexOf(selected[index].id) !== position) throw new RunnerError('SOURCE_SEARCH_CHANGED');
          await links.nth(position).click();
          await waitUntil(() => !session.page.frames().some(frame => frame.name() === 'guts'), 'SOURCE_DETAIL_NOT_OPEN');
          detail = await matchingFrame(session.page, 'gutsPage', '#entityname_entityid');
        }
        await waitUntil(async () => await detail.locator(fields.external_id).inputValue() === selected[index].id, 'SOURCE_DETAIL_ID_MISMATCH');
        const raw = Object.fromEntries(await Promise.all(Object.entries(fields).map(async ([key, selector]) => [key, await detail.locator(selector).inputValue()])));
        await session.assertAuthenticated();
        await verifySite(session, site);
        const result = pilotCustomer(raw, new Date().toISOString());
        if (result.skipped) skipped[result.skipped] = (skipped[result.skipped] || 0) + 1;
        else records.push(result.customer);
        await onRecord({ id: selected[index].id, ...result });
        emit({ event: 'pilot_source_record_read', completed: index + 1, selected: selected.length });
      }
      await entityMenu(session);
      return { records, selected: selected.length, skipped, coverage: allPages ? 'filtered_query_pages' : 'filtered_first_page_sample' };
    } finally { await session.browser.close(); }
  });
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const siteCode = value('--site');
  const inventory = await readJson(resolve(directory, 'era-sites.json'));
  if (inventory?.sourceOrigin !== new URL(process.env.ERAPOWER_URL).origin) throw new RunnerError('SOURCE_SITE_INVENTORY_REQUIRED');
  const site = inventory.sites.find(site => site.code === siteCode);
  if (!site?.backendSiteId) throw new RunnerError('MAPPED_PILOT_SITE_REQUIRED');
  const apply = args.includes('--apply');
  const checkpoint = resolve(directory, `pilot-${siteCode}-import.json`);
  await exclusiveRun(resolve(directory, 'customer-worker.lock'), async () => {
    let snapshot = await readJson(checkpoint);
    const client = apply ? await configuredBackendClient({ GOODSHOWROOM_SITE_ID: site.backendSiteId }) : null;
    if (client) await client.preflight();
    const binding = { sourceOrigin: inventory.sourceOrigin, siteId: site.backendSiteId, siteCode,
      ...(client ? { apiUrl: client.apiUrl, organisationId: client.organisationId } : {}) };
    if (snapshot) {
      if (!apply || JSON.stringify(snapshot.binding) !== JSON.stringify(binding)) throw new RunnerError('PILOT_PENDING_IMPORT_REQUIRES_SAME_BACKEND_AND_SITE');
      snapshot.records = normalizeBatch(snapshot.records);
    } else {
      const previewPath = resolve(directory, `pilot-${siteCode}-observations.json`);
      const observationBinding = { sourceOrigin: inventory.sourceOrigin, siteCode, siteId: site.backendSiteId };
      let result;
      if (args.includes('--use-preview')) {
        const preview = await readJson(previewPath);
        if (!preview || JSON.stringify(preview.binding) !== JSON.stringify(observationBinding)) throw new RunnerError('PILOT_PREVIEW_SITE_MISMATCH');
        result = preview.result;
        result.records = normalizeBatch(result.records);
        if (result.records.length > 9 || result.coverage !== 'filtered_first_page_sample') throw new RunnerError('INVALID_PILOT_PREVIEW');
      } else {
        result = await readPilot({ site, query: value('--query'), limit: Number(value('--limit') || 3) });
        // Retain original observation times for a later import without scraping again.
        await atomicJson(previewPath, { binding: observationBinding, result });
      }
      emit({ event: 'pilot_customer_read', selected: result.selected, valid: result.records.length, skipped: result.skipped, coverage: result.coverage, applied: false });
      if (!apply || !result.records.length) return;
      snapshot = { binding, records: result.records, offset: 0 };
      await atomicJson(checkpoint, snapshot);
    }
    await importBatches(client, snapshot.records, { startOffset: snapshot.offset,
      onBatch: async offset => { snapshot.offset = offset; await atomicJson(checkpoint, snapshot); } });
    const verified = await client.verifyImportedCustomers(snapshot.records);
    const { unlink } = await import('node:fs/promises');
    await unlink(checkpoint);
    emit({ event: 'pilot_customer_import_complete', count: snapshot.records.length, verified: verified.verified, coverage: 'filtered_first_page_sample', applied: true });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { emit({ event: 'pilot_customer_stopped', code: safeRunnerCode(error) }); process.exitCode = 1; });
}
