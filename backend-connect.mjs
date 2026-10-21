import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { localBrowserEndpoint } from './browser-connection.mjs';
import { createBackendClient, RunnerError } from './backend-client.mjs';
import { atomicJson } from './runner-state.mjs';

// Read only this project's Supabase cookie, never unrelated browser sessions.
export function sessionFromCookies(cookies, name) {
  let raw = cookies.find(cookie => cookie.name === name)?.value;
  if (!raw) {
    const chunks = cookies.filter(cookie => cookie.name.startsWith(`${name}.`))
      .map(cookie => ({ index: Number(cookie.name.slice(name.length + 1)), value: cookie.value }))
      .filter(chunk => Number.isInteger(chunk.index) && chunk.index >= 0).sort((a, b) => a.index - b.index);
    if (!chunks.length || chunks.some((chunk, index) => chunk.index !== index)) return null;
    raw = chunks.map(chunk => chunk.value).join('');
  }
  try {
    const value = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw;
    const session = JSON.parse(value);
    return typeof session.access_token === 'string' && !/\s/.test(session.access_token) ? session : null;
  } catch { return null; }
}

async function main() {
  const publicSettings = parseEnv(await readFile(new URL('../goodshowroom-pentana/.env.local', import.meta.url), 'utf8'));
  const project = new URL(publicSettings.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
  const frontend = new URL(process.env.GOODSHOWROOM_WEB_URL || 'http://localhost:3000');
  if (frontend.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(frontend.hostname) || frontend.username || frontend.password || frontend.search || frontend.hash) throw new RunnerError('LOCAL_FRONTEND_REQUIRED');
  const browser = await chromium.connectOverCDP(localBrowserEndpoint(process.env.ERAPOWER_CDP_URL).href, { timeout: 15000 });
  try {
    if (browser.contexts().length !== 1) throw new RunnerError('DEDICATED_BROWSER_REQUIRED');
    const context = browser.contexts()[0];
    let page = context.pages().find(page => { try { return new URL(page.url()).origin === frontend.origin; } catch { return false; } });
    if (!page) {
      page = await context.newPage();
      await page.goto(new URL('/login', frontend).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    await page.bringToFront();
    console.log('Sign into Good Showroom as ADMIN in the opened Chrome tab. Waiting for the application session; no password/token needs to be pasted.');
    const deadline = Date.now() + 300000;
    let waitingCode;
    while (Date.now() < deadline) {
      const session = sessionFromCookies(await context.cookies(frontend.href), `sb-${project}-auth-token`);
      if (session) {
        // Use the same transport validation as the runner before sending any token.
        const uuid = '00000000-0000-4000-8000-000000000000';
        const transport = createBackendClient({ ...process.env, GOODSHOWROOM_ACCESS_TOKEN: session.access_token,
          GOODSHOWROOM_SITE_ID: uuid, GOODSHOWROOM_ORGANISATION_ID: uuid });
        const response = await fetch(new URL('auth/me', transport.apiUrl), {
          headers: { Authorization: `Bearer ${session.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
        });
        if (response.status === 401) { await new Promise(done => setTimeout(done, 1000)); continue; }
        if (!response.ok) throw new RunnerError(`BACKEND_HTTP_${response.status}`);
        const current = await response.json();
        const sites = current.sites?.filter(site => site.roles?.includes('ADMIN')) ?? [];
        if (!sites.length) {
          const code = current.needsInitialSetup ? 'GOODSHOWROOM_INITIAL_SETUP_REQUIRED' : 'GOODSHOWROOM_ADMIN_ACCESS_REQUIRED';
          if (waitingCode !== code) console.log(JSON.stringify({ event: 'waiting_for_backend_admin', code }));
          waitingCode = code;
          await new Promise(done => setTimeout(done, 2000));
          continue;
        }
        const organisations = [...new Set(sites.map(site => site.organisation_id))];
        const organisationId = process.env.GOODSHOWROOM_ORGANISATION_ID || (organisations.length === 1 ? organisations[0] : null);
        if (!organisationId || !organisations.includes(organisationId)) throw new RunnerError('CHOOSE_ADMIN_ORGANISATION');
        const selected = sites.filter(site => site.organisation_id === organisationId).map(site => ({ id: site.id, name: site.name }));
        await atomicJson(fileURLToPath(new URL('./.auth/backend-session.json', import.meta.url)), {
          apiUrl: transport.apiUrl, accessToken: session.access_token, organisationId, sites: selected, connectedAt: new Date().toISOString(),
        });
        console.log(JSON.stringify({ event: 'backend_admin_connected', sites: selected.length }));
        return;
      }
      await new Promise(done => setTimeout(done, 1000));
    }
    throw new RunnerError('BACKEND_LOGIN_TIMED_OUT');
  } finally { await browser.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'backend_connect_failed', code: error instanceof RunnerError ? error.code : 'CHECK_LOCAL_APP_AND_BROWSER' }));
    process.exitCode = 1;
  });
}
