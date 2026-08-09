import { strict as assert } from 'node:assert';
import { beforeEach, test } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { convertLegacyExport } from '../scripts/convert-legacy.mjs';
import * as store from '../utils/storage';
import { compileFilters } from '../utils/filters';
import { buildRestoreUrl } from '../utils/normalize';

beforeEach(() => {
  fakeBrowser.reset();
});

const compile = (text = '') => compileFilters([{ id: 'test', text }]);

const NOW = 1_783_000_000_000;

/**
 * Covers every shape the real export contained, plus the malformed ones — but **only with
 * synthetic data**. This fixture was originally a slice of a real export, which put real
 * people's account URLs into the repository; it must stay on the domains RFC 2606 reserves
 * for documentation. `tests/no-real-data.test.ts` enforces the domain half of that.
 *
 * What each line is here to exercise:
 *   1 & last  the same URL twice, so dedup collapses it to the earliest addedAt
 *   2         a leading underscore and several more — the reason `titleFromUrl` is not used
 *   3         a multi-segment path plus a query, for the path-as-title and re-key cases
 *   4         a genuine page title carrying a browser unread counter, plus scroll offsets
 *   then      blank / whitespace / not-JSON / no-url / non-http / unparseable-timestamp
 */
const FIXTURE = [
  '{"timestamp":"2026-07-06T13:34:15.709Z","title":"https://example.com/plainhandle","url":"https://example.com/plainhandle"}',
  '{"timestamp":"2026-07-04T07:58:51.144Z","title":"https://example.com/_a_snake_cased_name","url":"https://example.com/_a_snake_cased_name"}',
  '{"timestamp":"2026-07-02T14:03:32.332Z","title":"https://example.com/tag/SOMETAG?src=share_click","url":"https://example.com/tag/SOMETAG?src=share_click"}',
  '{"timestamp":"2026-07-02T15:27:37.447Z","title":"(3) A Genuine Page Title (@someone) / Example","url":"https://example.com/someone","scroll":{"height":11032,"percent":"35%","top":2600}}',
  '',
  '   ',
  'not json at all',
  '{"timestamp":"2026-07-01T00:00:00.000Z","title":"no url here"}',
  '{"timestamp":"2026-07-01T00:00:00.000Z","title":"local file","url":"file:///C:/notes/a.html"}',
  '{"timestamp":"nonsense","title":"https://example.com/broken_stamp","url":"https://example.com/broken_stamp"}',
  '{"timestamp":"2026-07-01T10:00:00.000Z","title":"https://example.com/plainhandle","url":"https://example.com/plainhandle"}',
].join('\n');

function convert() {
  return convertLegacyExport(FIXTURE, { now: NOW });
}

test('the payload is shaped the way importPayload expects', () => {
  const { payload } = convert();
  assert.equal(payload.format, 'read-later');
  assert.equal(payload.schemaVersion, 1);
  assert.ok(Array.isArray(payload.items));
});

test('urlKey is never emitted — the importer owns key derivation', () => {
  const { payload } = convert();
  assert.ok(payload.items.every((item) => !('urlKey' in item)));
});

test('a title that is just the URL becomes the URL path, without slug mangling', () => {
  const { payload, report } = convert();
  const byUrl = new Map(payload.items.map((item) => [item.url, item]));
  assert.equal(byUrl.get('https://example.com/plainhandle')?.title, 'plainhandle');
  // Underscores are part of the name; titleFromUrl would have turned this into
  // 'a snake cased name', which is why the converter does not use it.
  assert.equal(byUrl.get('https://example.com/_a_snake_cased_name')?.title, '_a_snake_cased_name');
  assert.equal(byUrl.get('https://example.com/tag/SOMETAG?src=share_click')?.title, 'tag/SOMETAG');
  // Counted per source line, so the duplicate plainhandle entry is included.
  assert.equal(report.derivedTitles, 5);
});

test('a real title keeps its text but loses the browser unread counter', () => {
  const { payload } = convert();
  const item = payload.items.find((entry) => entry.url === 'https://example.com/someone');
  assert.equal(item?.title, 'A Genuine Page Title (@someone) / Example');
});

test('scroll becomes a percentage with an EMPTY textStart, never a fake anchor', () => {
  const { payload, report } = convert();
  const item = payload.items.find((entry) => entry.url === 'https://example.com/someone');
  assert.deepEqual(item?.progress, { scrollY: 2600, docHeight: 11032, percent: 0.35, textStart: '' });
  assert.equal(report.scrollCarried, 1);
});

test('entries without scroll get progress null, not a zero-percent placeholder', () => {
  const { payload } = convert();
  const item = payload.items.find((entry) => entry.url === 'https://example.com/plainhandle');
  assert.equal(item?.progress, null);
});

test('an imported percentage never produces a text fragment', () => {
  const { payload } = convert();
  const item = payload.items.find((entry) => entry.url === 'https://example.com/someone');
  assert.ok(item);
  const restored = buildRestoreUrl({ ...item, urlKey: 'k', progress: item.progress });
  assert.equal(restored, 'https://example.com/someone', 'no anchor means the URL must pass through untouched');
});

test('timestamps map to addedAt and updatedAt, with a visible fallback', () => {
  const { payload, report } = convert();
  const dated = payload.items.find((entry) => entry.url === 'https://example.com/_a_snake_cased_name');
  assert.equal(dated?.addedAt, Date.parse('2026-07-04T07:58:51.144Z'));
  assert.equal(dated?.addedAt, dated?.updatedAt);

  const broken = payload.items.find((entry) => entry.url === 'https://example.com/broken_stamp');
  assert.equal(broken?.addedAt, NOW);
  assert.equal(report.invalidTimestamps, 1);
});

test('duplicate URLs collapse to the earliest addedAt', () => {
  const { payload, report } = convert();
  const matches = payload.items.filter((entry) => entry.url === 'https://example.com/plainhandle');
  assert.equal(matches.length, 1);
  assert.equal(report.duplicateUrls, 1);
  assert.equal(matches[0]?.addedAt, Date.parse('2026-07-01T10:00:00.000Z'));
  assert.equal(matches[0]?.updatedAt, Date.parse('2026-07-06T13:34:15.709Z'));
});

test('unusable lines are dropped and accounted for, never silently', () => {
  const { report } = convert();
  assert.equal(report.unparseable, 1);
  assert.equal(report.missingUrl, 1);
  assert.equal(report.notHttp, 1);
  assert.equal(report.dropped.length, 3);
  assert.equal(report.lines, 9, 'blank lines are not counted as input');
  assert.equal(report.converted, 5);
});

test('items are emitted oldest first, matching the default queue order', () => {
  const { payload } = convert();
  const stamps = payload.items.map((item) => item.addedAt);
  assert.deepEqual(stamps, stamps.slice().sort((a, b) => a - b));
});

test('the converted payload imports cleanly end to end', async () => {
  const { payload, report } = convert();
  const result = await store.importPayload(payload, compile());

  assert.equal(result.created, report.converted);
  assert.equal(result.merged, 0);
  assert.equal(result.skipped, 0);

  const unread = await store.listUnread();
  assert.equal(unread.length, report.converted);

  // The importer derives the key from `url` using the active filters — default is empty,
  // so the query on the tag URL is part of the identity.
  const keys = unread.map((item) => item.urlKey).sort();
  assert.ok(keys.includes('https://example.com/plainhandle'));
  assert.ok(keys.includes('https://example.com/tag/SOMETAG?src=share_click'));
});

test('importing with a site filter active re-keys the same file differently', async () => {
  // Why the converter deliberately does not emit `urlKey`: the same file lands on
  // different keys depending on the filters active at import time, and that is correct.
  const { payload } = convert();
  await store.importPayload(payload, compile('||example.com^$removeparam'));
  const keys = (await store.listUnread()).map((item) => item.urlKey);
  assert.ok(keys.includes('https://example.com/tag/SOMETAG'), 'query stripped by the active filter');
  assert.ok(!keys.includes('https://example.com/tag/SOMETAG?src=share_click'));
});

test('importing the same file twice merges instead of duplicating', async () => {
  const { payload, report } = convert();
  await store.importPayload(payload, compile());
  const second = await store.importPayload(payload, compile());
  assert.equal(second.created, 0);
  assert.equal(second.merged, report.converted);
  assert.equal((await store.listUnread()).length, report.converted);
});
