import { openAuthenticatedSession } from './erapower-session.mjs';
import { atomicJson, readJson } from './runner-state.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function discoverSites(session) {
  await session.assertAuthenticated();
  const header = session.page.frames().find(frame => frame.name() === 'applicationHeader');
  const content = session.page.frames().find(frame => frame.name() === 'gutsPage');
  if (!header || !content) throw new Error('ERA_SITE_MENU_NOT_FOUND');
  // eraPower keeps the authorized site choices in a hidden menu template, then
  // renders the visible popup elsewhere. Discovery reads that menu, never data.
  if (!await content.locator('#oEntityContext div[id^="STORE"]').count()) await header.locator('#EntityMenu').click();
  await content.locator('#oEntityContext div[id^="STORE"]').first().waitFor({ state: 'attached', timeout: 15000 });
  const observations = await content.locator('#oEntityContext div[id^="STORE"]').evaluateAll(elements => elements.map(element => ({
    code: element.id.slice(5), label: element.textContent.replace(/\s+/g, ' ').trim(), selector: `#${element.id}`,
  })));
  const sites = new Map();
  // eraPower omits the active dealership from its switcher choices.
  // Include the observed header so discovery and repeated reads keep that site.
  const activeLabel = (await header.locator('#EntityMenu').innerText()).replace(/\s+/g, ' ').trim();
  const activeCode = activeLabel.match(/^(\d+)\|\s*/)?.[1];
  if (activeCode) sites.set(activeCode, { code: activeCode, label: activeLabel, selector: `#STORE${activeCode}` });
  for (const site of observations) {
    if (!/^[0-9]+$/.test(site.code) || !site.label) throw new Error('INVALID_ERA_SITE');
    if (sites.has(site.code) && sites.get(site.code).label !== site.label) throw new Error('CONFLICTING_ERA_SITE');
    sites.set(site.code, site);
  }
  if (!sites.size) throw new Error('NO_ERA_SITES');
  return [...sites.values()];
}

export async function selectSourceSite(session, site) {
  await session.assertAuthenticated();
  const currentHeader = session.page.frames().find(frame => frame.name() === 'applicationHeader');
  if (!currentHeader) throw new Error('ERA_SITE_MENU_NOT_FOUND');
  const currentLabel = (await currentHeader.locator('#EntityMenu').innerText()).replace(/\s+/g, ' ').trim();
  if (currentLabel === site.label || currentLabel === site.label.replace(/^\d+\|\s*/, '')) return site;
  const sites = await discoverSites(session);
  const observed = sites.find(candidate => candidate.code === site.code && candidate.label === site.label);
  if (!observed) throw new Error('SOURCE_SITE_NOT_AVAILABLE');
  const content = session.page.frames().find(frame => frame.name() === 'gutsPage');
  const header = session.page.frames().find(frame => frame.name() === 'applicationHeader');
  if (!await content.locator(`${observed.selector}:visible`).count()) await header.locator('#EntityMenu').click();
  await content.locator(`${observed.selector}:visible`).click();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await session.assertAuthenticated();
    const label = (await header.locator('#EntityMenu').innerText()).replace(/\s+/g, ' ').trim();
    // A site must be verified after switching before any record can be extracted.
    if (label === observed.label || label === observed.label.replace(/^\d+\|\s*/, '')) return observed;
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error('SOURCE_SITE_SWITCH_NOT_VERIFIED');
}

async function main() {
  const session = await openAuthenticatedSession();
  try {
    const sites = await discoverSites(session);
    const path = fileURLToPath(new URL('./.auth/era-sites.json', import.meta.url));
    const previous = await readJson(path);
    const sameSource = previous?.sourceOrigin === session.config.url.origin;
    const mapped = sites.map(site => ({ ...site, backendSiteId: sameSource ? previous.sites.find(old => old.code === site.code && old.label === site.label)?.backendSiteId ?? null : null }));
    await atomicJson(path, { sourceOrigin: session.config.url.origin, observedAt: new Date().toISOString(), sites: mapped });
    console.log(JSON.stringify({ event: 'source_sites_discovered', count: mapped.length, mapped: mapped.filter(site => site.backendSiteId).length }));
  } finally { await session.browser.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Site discovery failed. Verify the live session and eraPower menu.'); process.exitCode = 1; });
}
