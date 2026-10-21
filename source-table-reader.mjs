import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openAuthenticatedSession } from './erapower-session.mjs';
import { selectSourceSite } from './era-sites.mjs';
import { RunnerError, safeRunnerCode, configuredBackendClient } from './backend-client.mjs';
import { readJson, atomicJson, exclusiveRun } from './runner-state.mjs';

const directory = fileURLToPath(new URL('./.auth/', import.meta.url));
const pause = () => new Promise(done => setTimeout(done, 200));
const emit = value => console.log(JSON.stringify(value));
export const stockProfile = {
  menu: ['Showroom', 'Inventory Inquiry'],
  prepare: [{ selector: '#selNewUsed', value: 'New' }, { selector: '#selMakeInventory', value: 'KI' }, { selector: '#selStatus', value: 'All' }],
  action: 'Find', table: '#dtbNewResults', id: 'tempstocksearch_StockNum',
  scope: 'New KIA inventory, all source statuses, dealership 01',
  fields: { stock_number: ['tempstocksearch_StockNum', 'Stock number'], carline: ['tempstocksearch_Carline', 'Carline'],
    description: ['tempstocksearch_Desc', 'Description'], colour: ['tempstocksearch_Colour', 'Colour'],
    location: ['tempstocksearch_Location', 'Location'], price: ['tempstocksearch_ListPrice', 'List price'],
    age: ['tempstocksearch_Age', 'Age'], deal: ['tempstocksearch_Deal', 'Deal'], status: ['tempstocksearch_Status', 'Source status'] },
};

async function until(read, code, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await pause(); } while (Date.now() < deadline);
  throw new RunnerError(code);
}
async function contentFrame(session) {
  return until(() => session.page.frames().find(frame => frame.name() === 'gutsPage'), 'SOURCE_FRAME_NOT_READY');
}

export async function sourceHome(session) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await session.assertAuthenticated();
    const frame = await contentFrame(session);
    if (await frame.getByText('Showroom', { exact: true }).isVisible().catch(() => false) &&
        await frame.getByText('Entity Maintenance', { exact: true }).isVisible().catch(() => false)) return frame;
    const actions = session.page.frames().filter(frame => frame.name() === 'action').reverse();
    let exited = false;
    for (const action of actions) {
      const exit = action.getByText('Exit', { exact: true });
      if (await exit.isVisible().catch(() => false)) { await exit.click(); exited = true; break; }
    }
    if (!exited) throw new RunnerError('RETURN_TO_SOURCE_HOME_MENU');
    await pause();
  }
  throw new RunnerError('RETURN_TO_SOURCE_HOME_MENU');
}

export function pagePosition(text) {
  const match = text.replace(/\s+/g, ' ').match(/^Page\s+(\d+)\s+of\s+(\d+)$/i);
  if (!match || +match[1] < 1 || +match[2] < +match[1] || +match[2] > 1000) throw new RunnerError('UNVERIFIED_SOURCE_PAGINATION');
  return { current: +match[1], total: +match[2] };
}

export async function readSourceTable({ site, profile, maxRecords = 1000 }) {
  if (!profile?.fields?.[Object.keys(profile.fields)[0]] || !profile.table || !profile.id || !profile.scope) throw new RunnerError('VERIFIED_SOURCE_PROFILE_REQUIRED');
  const session = await openAuthenticatedSession();
  try {
    session.page.setDefaultTimeout(15000);
    await sourceHome(session);
    await selectSourceSite(session, site);
    for (const label of profile.menu) {
      const frame = await contentFrame(session);
      await frame.getByText(label, { exact: true }).click();
    }
    const frame = await contentFrame(session);
    await frame.locator(profile.table).waitFor({ state: 'visible' });
    for (const step of profile.prepare || []) await frame.locator(step.selector).selectOption(step.value);
    const actions = session.page.frames().filter(frame => frame.name() === 'action');
    const find = actions.at(-1).getByText(profile.action, { exact: true });
    await find.click();
    await until(async () => {
      await session.assertAuthenticated();
      return (await frame.locator(`${profile.table} input[id="${profile.id}"]`).first().inputValue()).trim();
    }, 'SOURCE_QUERY_EMPTY_OR_FAILED');
    const firstPosition = pagePosition(await frame.locator('#CurrentPg:visible').innerText());
    if (firstPosition.current !== 1) throw new RunnerError('SOURCE_QUERY_NOT_AT_FIRST_PAGE');
    const rows = []; const ids = new Set();
    for (let page = 1; page <= firstPosition.total; page++) {
      await session.assertAuthenticated();
      const header = session.page.frames().find(frame => frame.name() === 'applicationHeader');
      const siteLabel = (await header.locator('#EntityMenu').innerText()).replace(/\s+/g, ' ').trim();
      if (![site.label, site.label.replace(/^\d+\|\s*/, '')].includes(siteLabel)) throw new RunnerError('SOURCE_SITE_MISMATCH');
      const position = pagePosition(await frame.locator('#CurrentPg:visible').innerText());
      if (position.current !== page || position.total !== firstPosition.total) throw new RunnerError('SOURCE_PAGES_CHANGED_DURING_READ');
      const pageRows = await frame.locator(profile.table).evaluate((table, config) => {
        return [...table.querySelectorAll('tr')].filter(row => row.querySelector(`input[id="${config.id}"]`)).map(row => {
          const source_id = row.querySelector(`input[id="${config.id}"]`).value.trim();
          const cells = {};
          for (const [key, field] of Object.entries(config.fields)) {
            const matches = row.querySelectorAll(`input[id="${field[0]}"]`);
            if (matches.length !== 1) throw new Error('SOURCE_COLUMNS_CHANGED');
            cells[key] = matches[0].value.trim();
          }
          return { source_id, cells };
        });
      }, profile);
      if (!pageRows.length || pageRows.some(row => !row.source_id)) throw new RunnerError('SOURCE_ROW_ID_REQUIRED');
      for (const row of pageRows) {
        if (ids.has(row.source_id)) throw new RunnerError('SOURCE_PAGE_REPEATED_OR_DUPLICATE_ID');
        ids.add(row.source_id); rows.push(row);
      }
      if (rows.length > maxRecords) throw new RunnerError('SOURCE_RECORD_LIMIT_EXCEEDED');
      emit({ event: 'source_page_read', page, pages: firstPosition.total, records: rows.length });
      if (page < firstPosition.total) {
        await frame.locator('img[title="Move to next page"]:visible').click();
        await until(async () => pagePosition(await frame.locator('#CurrentPg:visible').innerText()).current === page + 1, 'SOURCE_PAGE_DID_NOT_ADVANCE');
      }
    }
    const result = { source_origin: session.config.url.origin, source_site_code: site.code, source_site_label: site.label,
      observed_at: new Date().toISOString(), coverage: 'filtered', scope: profile.scope,
      columns: Object.entries(profile.fields).map(([key, field]) => ({ key, label: field[1] })), rows };
    await sourceHome(session);
    return result;
  } finally { await session.browser.close(); }
}

async function main() {
  const args = process.argv.slice(2); const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const code = value('--site'); const dataset = value('--dataset');
  // Only the observed stock mapping is registered. Other mappings must be verified.
  if (dataset !== 'stock') throw new RunnerError('SOURCE_DATASET_MAPPING_NOT_VERIFIED');
  const inventory = await readJson(resolve(directory, 'era-sites.json'));
  const site = inventory?.sites?.find(site => site.code === code);
  if (!site?.backendSiteId || inventory.sourceOrigin !== new URL(process.env.ERAPOWER_URL).origin) throw new RunnerError('MAPPED_SOURCE_SITE_REQUIRED');
  if (code !== '01') throw new RunnerError('SOURCE_PROFILE_ONLY_VERIFIED_FOR_SITE_01');
  await exclusiveRun(resolve(directory, 'browser-worker.lock'), async () => {
    const path = resolve(directory, `source-${code}-${dataset}.json`);
    const binding = { siteId: site.backendSiteId, sourceOrigin: inventory.sourceOrigin };
    let read;
    if (args.includes('--use-preview')) {
      const preview = await readJson(path);
      if (!preview || JSON.stringify(preview.binding) !== JSON.stringify(binding)) throw new RunnerError('SOURCE_PREVIEW_SITE_MISMATCH');
      read = preview.read;
    } else {
      read = await readSourceTable({ site, profile: stockProfile });
      await atomicJson(path, { binding, read });
    }
    if (args.includes('--apply')) {
      const client = await configuredBackendClient({ GOODSHOWROOM_SITE_ID: site.backendSiteId });
      await client.preflight();
      const result = await client.importSourceRead(dataset, read);
      emit({ event: 'source_read_imported', dataset, count: result.imported, replayed: result.replayed });
    } else emit({ event: 'source_read_preview', dataset, count: read.rows.length, coverage: read.coverage, applied: false });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { emit({ event: 'source_read_stopped', code: safeRunnerCode(error) }); process.exitCode = 1; });
}
