import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chromium } from 'playwright-core';
import { localBrowserEndpoint } from './browser-connection.mjs';

const authDir = new URL('./.auth/', import.meta.url);
const stateFile = new URL('erapower-state.json', authDir);
const defaultUrl = 'https://c2892-erapower.pentana.cloud/base/templates/vIndependent.htm';

export function pageOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

export function scopedBrowserState(state, url) {
  const domainMatches = domain => {
    const host = domain.replace(/^\./, '');
    return url.hostname === host || url.hostname.endsWith(`.${host}`);
  };
  return { ...state,
    cookies: state.cookies.filter(cookie => domainMatches(cookie.domain)),
    origins: state.origins.filter(entry => entry.origin === url.origin),
    sessionStorage: (state.sessionStorage || []).filter(entry => entry.origin === url.origin),
  };
}

function settings() {
  const url = new URL(process.env.ERAPOWER_URL || defaultUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('ERAPOWER_URL must be an HTTPS URL without embedded credentials.');
  }
  return {
    url,
    channel: process.env.ERAPOWER_BROWSER_CHANNEL || 'chrome',
    timezoneId: process.env.ERAPOWER_TIMEZONE || 'Australia/Melbourne',
    ready: process.env.ERAPOWER_READY_SELECTOR?.trim(),
    frame: process.env.ERAPOWER_READY_FRAME?.trim(),
  };
}

async function loadState(config, optional = false) {
  try {
    const saved = JSON.parse(await readFile(stateFile, 'utf8'));
    if (saved.applicationOrigin !== config.url.origin) {
      throw new Error('Saved session belongs to a different eraPower origin. Sign in again with session:login -- --fresh.');
    }
    return scopedBrowserState(saved, config.url);
  } catch (error) {
    if (error.code === 'ENOENT' && optional) return undefined;
    if (error.code === 'ENOENT') throw new Error('No saved session. Run npm run session:login and complete sign-in and MFA.');
    throw error;
  }
}

export async function openSession({ show = false, fresh = false, optional = false } = {}) {
  const config = settings();
  if (process.env.ERAPOWER_CDP_URL) {
    if (fresh) throw new Error('Fresh login is unavailable while using the live browser. Sign out interactively if needed.');
    const endpoint = localBrowserEndpoint(process.env.ERAPOWER_CDP_URL);
    const browser = await chromium.connectOverCDP(endpoint.href, { timeout: 15000 });
    try {
      const contexts = browser.contexts();
      if (contexts.length !== 1) throw new Error('Use one dedicated eraPower browser context.');
      const context = contexts[0];
      const pages = context.pages().filter(page => pageOrigin(page.url()) === config.url.origin && new URL(page.url()).pathname === config.url.pathname);
      if (pages.length !== 1) throw new Error('Keep exactly one eraPower application tab open in the dedicated browser.');
      // Reuse the existing page: reloading this frameset can discard runtime login state.
      // Closing a connectOverCDP Browser disconnects this client, preserving Chrome.
      return { browser, context, page: pages[0], config, attached: true };
    } catch (error) { await browser.close(); throw error; }
  }
  const saved = fresh ? undefined : await loadState(config, optional);
  const browser = await chromium.launch({ channel: config.channel, headless: !show });
  try {
    const context = await browser.newContext({
      ...(saved ? { storageState: { cookies: saved.cookies, origins: saved.origins } } : {}),
      timezoneId: config.timezoneId,
      viewport: { width: 1600, height: 1000 },
    });
    // Restore sessionStorage only to its original origin, as in the reference project.
    await context.addInitScript(entries => {
      const items = entries[location.origin];
      if (items && !sessionStorage.length) {
        for (const [key, value] of Object.entries(items)) sessionStorage.setItem(key, value);
      }
    }, Object.fromEntries((saved?.sessionStorage || []).map(entry => [entry.origin, entry.items])));
    const page = await context.newPage();
    await page.goto(config.url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return { browser, context, page, config };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function authenticatedPage(context, config) {
  if (!config.ready) throw new Error('Set ERAPOWER_READY_SELECTOR to a verified signed-in-only element before unattended use.');
  const [, loginVisible] = await Promise.all([assertSourceAvailable(context, config.url.origin), hasLoginForm(context)]);
  if (loginVisible) return null;
  for (const page of context.pages()) {
    if (pageOrigin(page.url()) !== config.url.origin) continue;
    const root = config.frame?.startsWith('name:')
      ? page.frames().find(frame => frame.name() === config.frame.slice(5))
      : config.frame ? page.frameLocator(config.frame) : page;
    if (!root) continue;
    if (await root.locator(config.ready).first().isVisible()) return page;
  }
  return null;
}

export async function assertSourceAvailable(context, origin) {
  const frames = context.pages().filter(page => pageOrigin(page.url()) === origin)
    .flatMap(page => page.frames()).filter(frame => pageOrigin(frame.url()) === origin);
  const disconnected = await Promise.all(frames.map(frame => frame.getByText('Network Connection Lost', { exact: true }).first().isVisible().catch(() => false)));
  if (disconnected.some(Boolean)) throw new Error('SOURCE_UNAVAILABLE: eraPower reports Network Connection Lost. Restore the live connection before continuing.');
}

// Verified on this dealer's live eraPower login frame. The outer frameset itself
// is also present before login, so its presence cannot prove authentication.
async function hasLoginForm(context) {
  const origin = settings().url.origin;
  const frames = context.pages().flatMap(page => page.frames()).filter(frame => pageOrigin(frame.url()) === origin);
  return (await Promise.all(frames.map(frame => frame.locator('input#password[type="password"]').isVisible().catch(() => false)))).some(Boolean);
}

export async function assertAuthenticatedSession(session) {
  if (!await authenticatedPage(session.context, session.config)) {
    throw new Error('AUTH_REQUIRED: authentication check failed. Complete session:login again.');
  }
}

async function saveState(context, config) {
  const state = await context.storageState({ indexedDB: true });
  const byOrigin = new Map();
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      try {
        const entry = await frame.evaluate(() => ({ origin: location.origin, items: Object.fromEntries(Object.entries(sessionStorage)) }));
        if (entry.origin !== 'null' && Object.keys(entry.items).length) byOrigin.set(entry.origin, entry);
      } catch { /* Detached or inaccessible frames do not contain exportable state. */ }
    }
  }
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  const temporary = new URL('erapower-state.tmp', authDir);
  await writeFile(temporary, JSON.stringify(scopedBrowserState({
    applicationOrigin: config.url.origin,
    exportedAt: new Date().toISOString(),
    ...state,
    sessionStorage: [...byOrigin.values()],
  }, config.url)), { mode: 0o600 });
  await rename(temporary, stateFile);
}

async function login() {
  const session = await openSession({ show: true, optional: true, fresh: process.argv.includes('--fresh') });
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log('Complete eraPower sign-in and any MFA in the browser. Use the site’s remember-device option if offered.');
    const answer = await prompt.question('Once the working eraPower screen is open, type SAVE to save this session: ');
    if (answer.trim() !== 'SAVE') throw new Error('Session was not saved.');
    if (await hasLoginForm(session.context)) {
      console.error('The eraPower Username/Password/Workstation login form is still visible. Finish login before saving.');
      throw new Error('AUTH_REQUIRED');
    }
    if (session.config.ready) {
      if (!await authenticatedPage(session.context, session.config)) throw new Error('Signed-in element not found. Session was not saved.');
    } else if (!session.context.pages().some(page => pageOrigin(page.url()) === session.config.url.origin)) {
      throw new Error('Return to the eraPower application before saving.');
    }
    await saveState(session.context, session.config);
    console.log('Session saved in .auth/erapower-state.json. Authentication was confirmed by the operator' + (session.config.ready ? ' and configured page check.' : '; configure the signed-in element before unattended use.'));
  } finally {
    prompt.close();
    await session.browser.close();
  }
}

// Scrapers should call this before any read or write. No credentials or MFA are submitted.
export async function openAuthenticatedSession({ show = false, timeoutMs = 30000 } = {}) {
  if (!settings().ready) throw new Error('Configure ERAPOWER_READY_SELECTOR before unattended use.');
  const session = await openSession({ show });
  try {
    const deadline = Date.now() + timeoutMs;
    do {
      const page = await authenticatedPage(session.context, session.config);
      if (page) return { ...session, page, assertAuthenticated: () => assertAuthenticatedSession(session) };
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    throw new Error('AUTH_REQUIRED: saved session was not accepted, MFA/sign-in is required, or the signed-in selector is incorrect. Run session:login to verify.');
  } catch (error) {
    await session.browser.close();
    throw error;
  }
}

async function test() {
  const session = await openAuthenticatedSession({ show: process.argv.includes('--show') });
  try {
    await saveState(session.context, session.config);
    console.log('Authenticated eraPower screen verified; saved session refreshed.');
  } finally { await session.browser.close(); }
}

async function inspect() {
  const saved = await loadState(settings());
  console.log(JSON.stringify({
    exportedAt: saved.exportedAt,
    applicationOrigin: saved.applicationOrigin,
    cookieCount: saved.cookies.length,
    storageOriginCount: saved.origins.length,
    sessionStorageOriginCount: saved.sessionStorage.length,
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const commands = { login, test, inspect };
  const command = commands[process.argv[2]];
  if (!command) { console.error('Use login, test, or inspect.'); process.exitCode = 1; }
  else command().catch(error => {
    // Avoid logging browser errors: they can contain redirect URLs or session tokens.
    if (error.message?.startsWith('SOURCE_UNAVAILABLE:')) console.error('SOURCE_UNAVAILABLE: eraPower reports Network Connection Lost. Restore the browser connection before retrying.');
    else if (error.message?.startsWith('AUTH_REQUIRED:')) console.error('AUTH_REQUIRED: complete eraPower login/MFA in the dedicated browser and rerun session:test.');
    else console.error('Session operation failed. Check configuration, browser installation, and sign-in. For test failures, run session:login and verify the authenticated selector.');
    process.exitCode = 1;
  });
}
