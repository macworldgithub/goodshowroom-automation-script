import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOrigin, assertSourceAvailable, scopedBrowserState } from '../erapower-session.mjs';
import { localBrowserEndpoint } from '../browser-connection.mjs';

test('loading frames without a URL do not crash authentication checks', () => {
  assert.equal(pageOrigin(''), null);
  assert.equal(pageOrigin('about:blank'), 'null');
  assert.equal(pageOrigin('https://dealer.example/base/app'), 'https://dealer.example');
});

test('live-browser control is restricted to a local port', () => {
  assert.equal(localBrowserEndpoint().port, '9223');
  for (const endpoint of ['https://remote.example:9223', 'http://remote.example:9223', 'http://user:secret@localhost:9223', 'http://localhost:9223/path', 'http://localhost:9223?token=secret']) {
    assert.throws(() => localBrowserEndpoint(endpoint), /BROWSER_ENDPOINT_MUST_BE_LOCAL/);
  }
});

test('a populated header cannot make a disconnected eraPower page healthy', async () => {
  const origin = 'https://dealer.example';
  const frame = { url: () => `${origin}/app`, getByText: () => ({ first: () => ({ isVisible: async () => true }) }) };
  const context = { pages: () => [{ url: () => `${origin}/app`, frames: () => [frame] }] };
  await assert.rejects(assertSourceAvailable(context, origin), /SOURCE_UNAVAILABLE/);
  await assert.doesNotReject(assertSourceAvailable(context, 'https://another.example'));
});

test('eraPower exports exclude Good Showroom and unrelated browser credentials', () => {
  const source = new URL('https://dealer.pentana.cloud/app');
  const state = scopedBrowserState({ cookies: [{ domain: 'dealer.pentana.cloud' }, { domain: '.pentana.cloud' }, { domain: 'localhost' }, { domain: 'unrelated.example' }],
    origins: [{ origin: source.origin }, { origin: 'http://localhost:3000' }],
    sessionStorage: [{ origin: source.origin }, { origin: 'http://localhost:3000' }],
  }, source);
  assert.equal(state.cookies.length, 2);
  assert.equal(state.origins.length, 1);
  assert.equal(state.sessionStorage.length, 1);
});
