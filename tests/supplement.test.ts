import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';
import { compileFilters } from '../utils/filters';
import { makeTranslate } from '../utils/i18n';
import { normalizeUrl } from '../utils/normalize';

/**
 * THE ONE TEST FILE THAT NAMES REAL DOMAINS, and the reason it is separate.
 *
 * `public/filters/supplement.txt` is a list of real sites — that is what a filter list is —
 * so asserting what it does necessarily means naming them. Every other fixture in `tests/`
 * uses RFC 2606 names and `no-real-data.test.ts` enforces that; keeping these four
 * assertions here rather than in `normalize.test.ts` is what lets that scan stay strict.
 *
 * None of it is anybody's browsing history: each hostname appears because the shipped file
 * has a rule for it.
 */
function supplement(): string {
  return readFileSync(resolve(process.cwd(), 'public', 'filters', 'supplement.txt'), 'utf8');
}

const key = (url: string): string => {
  const result = normalizeUrl(url, compileFilters([{ id: 'supplement', text: supplement() }]));
  assert.ok(result, `normalizeUrl returned null for ${url}`);
  return result.urlKey;
};

test('the shipped supplement parses with no gaps and no bad syntax', () => {
  const compiled = compileFilters([{ id: 'supplement', text: supplement() }]);
  assert.ok(compiled.active > 0, 'produced no filters');
  assert.deepEqual(
    compiled.skipped,
    [],
    `every line must be honoured: ${JSON.stringify(compiled.skipped)}`,
  );
});

test('the supplement clears the query on the sites upstream leaves alone', () => {
  // `||zhihu.com^` covers the subdomain too, which the old format needed two lines for.
  assert.equal(key('https://zhuanlan.zhihu.com/p/1?utm_source=x'), 'https://zhuanlan.zhihu.com/p/1');
  assert.equal(key('https://juejin.cn/post/1?from=search'), 'https://juejin.cn/post/1');
});

test('the supplement keeps v2ex pagination, so page 2 is not merged into page 1', () => {
  // The one place the inverted form earns its ugliness: this is the old `keep: p`, and
  // without it a thread's second page would collapse onto its first.
  const first = key('https://v2ex.com/t/123?p=1&from=share');
  const second = key('https://v2ex.com/t/123?p=2');
  assert.equal(first, 'https://v2ex.com/t/123?p=1');
  assert.notEqual(first, second);
});

test('the supplement carries the utm params AdGuard emits in a form uBO discards', () => {
  // AdGuard writes these as `$denyallow=…,removeparam=utm_source` with no `$domain`, which
  // uBO voids outright — so subscribing to its list leaves the six canonical utm params in
  // place. `scripts/filter-probe.mjs` is what measured that; this pins the consequence.
  assert.equal(key('https://example.com/a?utm_source=x&utm_medium=y&id=7'), 'https://example.com/a?id=7');
  assert.equal(key('https://example.com/a?utm_campaign=x&utm_term=y&utm_content=z&id=7'), 'https://example.com/a?id=7');
  assert.equal(key('https://example.com/a?_ga=1&irclickid=2&id=7'), 'https://example.com/a?id=7');
});

test('the supplement carries params no upstream list has', () => {
  // The guard against it drifting back into a hand-maintained tracking table: every param
  // line in that file is there because it was checked against the upstream list first.
  assert.equal(key('https://example.com/a?li_fat_id=1&id=7'), 'https://example.com/a?id=7');
  assert.equal(key('https://example.com/a?sharer_shareid=1&id=7'), 'https://example.com/a?id=7');
  assert.equal(
    key('https://example.com/a?gclid=1&fbclid=2&id=7'),
    'https://example.com/a?gclid=1&fbclid=2&id=7',
    'gclid and fbclid are upstream’s job and it does honour them — duplicating those here ' +
      'is exactly what we are avoiding',
  );
});

test('the rule counts quoted in the settings copy match what the file contains', () => {
  const rules = supplement()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('!'));
  const siteScoped = rules.filter((line) => line.startsWith('||')).length;
  const globalParams = rules.length - siteScoped;

  // `sub.presetSupplementDesc` states both counts, because they are what a user weighs when
  // deciding whether this list alone is enough. Prose is not data: adding a rule and leaving
  // the sentence alone turns it into a lie that nothing else in the suite would notice.
  for (const locale of ['en', 'zh'] as const) {
    const description = makeTranslate(locale)('sub.presetSupplementDesc');
    assert.ok(
      description.includes(String(globalParams)),
      `${locale}: copy must state ${globalParams} params, got “${description}”`,
    );
    assert.ok(
      description.includes(String(siteScoped)),
      `${locale}: copy must state ${siteScoped} site rules, got “${description}”`,
    );
  }
});
