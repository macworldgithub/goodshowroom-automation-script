import { openAuthenticatedSession } from './erapower-session.mjs';
import { browserRoot } from './browser-root.mjs';
import { selectSourceSite } from './era-sites.mjs';
import { exclusiveRun } from './runner-state.mjs';
import { fileURLToPath } from 'node:url';

export function validateCustomerProfile(profile) {
  if (!profile?.url || !profile.site?.selector || !profile.site?.expectedText || !profile.rows || !profile.loaded || !profile.fields) {
    throw new Error('VERIFIED_CUSTOMER_PROFILE_REQUIRED');
  }
  for (const field of ['external_id', 'first_name', 'last_name']) {
    if (!profile.fields[field]?.selector) throw new Error('VERIFIED_CUSTOMER_FIELDS_REQUIRED');
  }
  if (!profile.fields.email?.selector && !profile.fields.phone?.selector) throw new Error('CONTACT_MAPPING_REQUIRED');
  for (const [key, fallback, max] of [['maxPages', 100, 1000], ['maxRecords', 10000, 10000]]) {
    if (!Number.isInteger(profile[key] ?? fallback) || (profile[key] ?? fallback) < 1 || (profile[key] ?? fallback) > max) throw new Error('INVALID_EXTRACTION_LIMIT');
  }
  return profile;
}

export function profileMapping(profile) {
  validateCustomerProfile(profile);
  return { ...profile, customerUrl: profile.url, siteSelector: profile.site.selector,
    siteText: profile.site.expectedText, siteFrame: profile.site.frame, loadedSelector: profile.loaded };
}

// Only configure selectors observed in the real authorised customer screen.
export async function readBrowserCustomers(mapping, { show = false } = {}) {
  return exclusiveRun(fileURLToPath(new URL('./.auth/browser-worker.lock', import.meta.url)), () => readCustomers(mapping, { show }));
}

async function readCustomers(mapping, { show = false } = {}) {
  if (!mapping?.customerUrl || !mapping.siteSelector || !mapping.siteText || !mapping.rows || !mapping.loadedSelector || !mapping.fields) {
    throw new Error('Customer screen mapping is incomplete. Verify URL, site, loaded marker, rows and field selectors in eraPower.');
  }
  for (const field of ['external_id', 'first_name', 'last_name']) {
    if (!mapping.fields[field]?.selector) throw new Error(`Missing verified selector for ${field}.`);
  }
  const session = await openAuthenticatedSession({ show });
  try {
    const customerUrl = new URL(mapping.customerUrl, session.config.url);
    if (customerUrl.origin !== session.config.url.origin) throw new Error('Customer screen must use the configured eraPower origin.');
    if (session.page.url() !== customerUrl.href) await session.page.goto(customerUrl.href, { waitUntil: 'domcontentloaded' });
    session.page.setDefaultTimeout(15000);
    if (mapping.sourceSite) await selectSourceSite(session, mapping.sourceSite);
    // Only configure these from inspected, read-only menu navigation.
    for (const step of mapping.navigation ?? []) {
      await session.assertAuthenticated();
      if (!step.selector || !['click', 'select'].includes(step.action)) throw new Error('INVALID_READ_NAVIGATION');
      const target = browserRoot(session.page, step.frame).locator(step.selector);
      if (step.action === 'click') await target.click();
      else await target.selectOption(step.value);
    }
    const root = browserRoot(session.page, mapping.frame);
    const siteRoot = browserRoot(session.page, mapping.siteFrame ?? mapping.frame);
    const verifySite = async () => {
      await session.assertAuthenticated();
      if ((await siteRoot.locator(mapping.siteSelector).innerText()).replace(/\s+/g, ' ').trim() !== mapping.siteText) throw new Error('SOURCE_SITE_MISMATCH');
    };
    const readField = async (row, spec) => {
      if (!spec) return null;
      const cell = row.locator(spec.selector);
      if (await cell.count() !== 1) throw new Error('Mapped field selector must match exactly one element.');
      return spec.attribute ? cell.getAttribute(spec.attribute) : spec.input ? cell.inputValue() : cell.innerText();
    };
    const records = [];
    const signatures = new Set();
    const maxPages = mapping.maxPages ?? 100;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('maxPages must be 1–1000.');
    for (let index = 0; index < maxPages; index++) {
      await session.assertAuthenticated();
      await root.locator(mapping.loadedSelector).waitFor({ state: 'visible' });
      await verifySite();
      const rows = root.locator(mapping.rows);
      const count = await rows.count();
      if (!count) throw new Error('Customer page is empty or mapping is incorrect.');
      const observed_at = new Date().toISOString();
      const pageRecords = [];
      for (let i = 0; i < count; i++) {
        const record = {};
        for (const field of ['external_id', 'first_name', 'last_name', 'email', 'phone', 'revision']) {
          const value = await readField(rows.nth(i), mapping.fields[field]);
          if (value != null) record[field] = value.trim();
        }
        // Privacy requires explicit observed-value mappings; never infer granted.
        if (mapping.privacy) {
          record.privacy = {};
          for (const field of ['do_not_contact', 'email', 'sms', 'call']) {
            const spec = mapping.privacy[field];
            const value = (await readField(rows.nth(i), spec))?.trim();
            if (!spec?.values || !Object.hasOwn(spec.values, value)) throw new Error('Unmapped source privacy value.');
            record.privacy[field] = spec.values[value];
          }
        }
        pageRecords.push({ ...record, observed_at });
      }
      const signature = JSON.stringify(pageRecords.map(record => record.external_id));
      if (signatures.has(signature)) throw new Error('Pagination repeated a customer page; extraction aborted.');
      signatures.add(signature);
      records.push(...pageRecords);
      if (records.length > (mapping.maxRecords ?? 10000)) throw new Error('EXTRACTION_LIMIT_EXCEEDED');
      await verifySite();
      if (!mapping.next) return records;
      const next = root.locator(mapping.next);
      if (await next.count() !== 1) throw new Error('Next-page control is missing or ambiguous.');
      if (await next.isDisabled() || await next.getAttribute('aria-disabled') === 'true') return records;
      if (index + 1 === maxPages) throw new Error('Page limit reached; extraction aborted rather than importing a truncated list.');
      await session.assertAuthenticated();
      await next.click();
      // Confirm the data changed before reading another page.
      const deadline = Date.now() + 30000;
      while ((await readField(root.locator(mapping.rows).first(), mapping.fields.external_id))?.trim() === pageRecords[0].external_id) {
        if (Date.now() >= deadline) throw new Error('Customer page did not change after pagination.');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    throw new Error('Incomplete customer extraction.');
  } finally { await session.browser.close(); }
}
