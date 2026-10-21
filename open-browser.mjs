import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { localBrowserEndpoint } from './browser-connection.mjs';

// A dedicated profile, never the user's personal Chrome profile.
const endpoint = localBrowserEndpoint(process.env.ERAPOWER_CDP_URL);
const source = new URL(process.env.ERAPOWER_URL || 'https://c2892-erapower.pentana.cloud/base/templates/vIndependent.htm');
if (source.protocol !== 'https:' || source.username || source.password) throw new Error('Configure an HTTPS eraPower URL.');
let browser;
try {
  browser = await chromium.launchPersistentContext(fileURLToPath(new URL('./.auth/chrome-profile/', import.meta.url)), {
    channel: process.env.ERAPOWER_BROWSER_CHANNEL || 'chrome', headless: false,
    timezoneId: process.env.ERAPOWER_TIMEZONE || 'Australia/Melbourne', viewport: null,
    args: [`--remote-debugging-port=${endpoint.port}`, '--remote-debugging-address=127.0.0.1', '--start-maximized'],
  });
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(source.href, { waitUntil: 'domcontentloaded' });
  console.log('Dedicated eraPower browser is open. Complete login/MFA and keep this window open while the worker runs.');
  await new Promise(done => browser.once('close', done));
} catch {
  await browser?.close().catch(() => {});
  console.error('Could not open the dedicated browser. Check installation, configured port and whether this profile is already open.');
  process.exitCode = 1;
}
