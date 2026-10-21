import test from 'node:test';
import assert from 'node:assert/strict';
import { pagePosition } from '../source-table-reader.mjs';
test('source pagination handles eraPower whitespace and rejects unverified counts', () => {
  assert.deepEqual(pagePosition('Page\u00a01\u00a0of\u00a032'), { current: 1, total: 32 });
  for (const text of ['Page 0 of 1', 'Page 3 of 2', 'Page 1 of 1001', 'Page 1', '']) assert.throws(() => pagePosition(text), /UNVERIFIED_SOURCE_PAGINATION/);
});
