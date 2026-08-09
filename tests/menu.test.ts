import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { MENU_PREFIX_MAX, MENU_SAVE_LINK, MENU_SAVE_PAGE, menuDefinitions, menuTitle, sanitizeMenuPrefix } from '../utils/menu';
import { makeTranslate } from '../utils/i18n';

const zh = makeTranslate('zh');
const en = makeTranslate('en');

test('an empty prefix leaves the localised title exactly as it was', () => {
  assert.equal(menuTitle('', 'Read Later (this page)'), 'Read Later (this page)');
  assert.equal(menuTitle('   ', 'Read Later (this page)'), 'Read Later (this page)');
});

test('a prefix is joined by exactly one space', () => {
  assert.equal(menuTitle('1', 'Read Later'), '1 Read Later');
  assert.equal(menuTitle('  A  ', 'Read Later'), 'A Read Later');
  assert.equal(menuTitle('★', '稍后再读（当前页）'), '★ 稍后再读（当前页）');
});

test('%s is dropped, because the browser would splice the selected text in', () => {
  // `contextMenus` defines no escape for it, so removal is the only safe handling.
  assert.equal(sanitizeMenuPrefix('%s'), '');
  assert.equal(sanitizeMenuPrefix('a%sb'), 'ab');
  assert.equal(sanitizeMenuPrefix('%S'), '', 'case-insensitively');
  assert.equal(menuTitle('%s', 'Read Later'), 'Read Later');
});

test('internal whitespace is collapsed so a prefix cannot pad the label out', () => {
  assert.equal(sanitizeMenuPrefix('a\t\n  b'), 'a b');
});

test('a prefix is capped, and the cap cannot leave trailing space', () => {
  const long = sanitizeMenuPrefix('x'.repeat(50));
  assert.equal(long.length, MENU_PREFIX_MAX);
  // Slicing mid-string could otherwise end on the space, which would show up in the label.
  const spaced = sanitizeMenuPrefix(`${'y'.repeat(MENU_PREFIX_MAX - 1)} zzz`);
  assert.equal(spaced, 'y'.repeat(MENU_PREFIX_MAX - 1));
  assert.ok(!spaced.endsWith(' '));
});

test('sanitizing is idempotent — the options page and the background can both run it', () => {
  for (const raw of ['1', ' A ', '%s!', 'x'.repeat(40), 'a  b', '']) {
    const once = sanitizeMenuPrefix(raw);
    assert.equal(sanitizeMenuPrefix(once), once, `not idempotent for ${JSON.stringify(raw)}`);
  }
});

test('the prefix reaches BOTH menu definitions, in both locales', () => {
  // The regression this file exists for. Every earlier test covered `menuTitle` in isolation
  // while the bug lived in the step after it, so this asserts the thing the background
  // actually hands to `contextMenus.create`.
  for (const tr of [zh, en]) {
    const defs = menuDefinitions('1', tr);
    assert.equal(defs.length, 2);
    for (const def of defs) {
      assert.ok(def.title.startsWith('1 '), `prefix missing from ${JSON.stringify(def.title)}`);
    }
  }
});

test('an empty prefix produces the plain localised titles', () => {
  const [page, link] = menuDefinitions('', zh);
  assert.equal(page?.title, '稍后再读（当前页）');
  assert.equal(link?.title, '稍后再读此链接');
});

test('the two definitions carry the ids and contexts the click handler dispatches on', () => {
  const [page, link] = menuDefinitions('', en);
  assert.equal(page?.id, MENU_SAVE_PAGE);
  assert.equal(link?.id, MENU_SAVE_LINK);
  assert.deepEqual(page?.create.contexts, ['page']);
  assert.deepEqual(link?.create.contexts, ['link']);
  // http(s) only, matching `isSavableUrl` and `normalizeUrl` (D30/D7).
  assert.deepEqual(page?.create.documentUrlPatterns, ['http://*/*', 'https://*/*']);
  assert.deepEqual(link?.create.targetUrlPatterns, ['http://*/*', 'https://*/*']);
  assert.equal(page?.create.targetUrlPatterns, undefined, 'the page item is not link-scoped');
  assert.equal(link?.create.documentUrlPatterns, undefined, 'a link is savable from any page (D7)');
});

test('each call returns fresh pattern arrays, so a caller cannot mutate the next one', () => {
  const first = menuDefinitions('', en);
  first[0]?.create.documentUrlPatterns?.push('ftp://*/*');
  const second = menuDefinitions('', en);
  assert.deepEqual(second[0]?.create.documentUrlPatterns, ['http://*/*', 'https://*/*']);
});
