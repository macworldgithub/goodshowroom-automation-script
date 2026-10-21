import { openSession } from './erapower-session.mjs';

// Read-only DOM inspection. Never prints form values, session state or raw HTML.
const session = await openSession();
try {
  for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
    const header = session.page.frames().find(frame => frame.name() === 'applicationHeader');
    if ((await header?.locator('#AppUser').innerText().catch(() => ''))?.trim()) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (process.argv.includes('--entities')) {
    const header = session.page.frames().find(frame => frame.name() === 'applicationHeader');
    await header.locator('#EntityMenu').click();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  for (const frame of session.page.frames()) {
    if (!process.argv.includes('--entities') && !['applicationHeader', 'entityHeader', 'toolb', 'gutsPage', 'header'].includes(frame.name())) continue;
    const elements = await frame.locator('[id], [title], [onclick], select option').evaluateAll(items => items.slice(0, 110).map(el => ({
      tag: el.tagName,
      id: el.id,
      title: el.getAttribute('title'),
      name: el.getAttribute('name'),
      text: ['INPUT', 'SCRIPT', 'STYLE'].includes(el.tagName) ? '' : (el.innerText || el.textContent || '').trim().slice(0, 160),
    })));
    console.log(JSON.stringify({ frame: frame.name(), elements }));
  }
} finally { await session.browser.close(); }
