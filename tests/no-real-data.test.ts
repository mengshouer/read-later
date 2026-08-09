import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

/**
 * Some of these files were first written by copying rows out of a real read-later export,
 * which put real people's account URLs into the repository. They were rewritten with
 * synthetic data; this keeps them that way.
 *
 * The rule is broader than the check — nothing mechanical can tell a real page *title* from
 * an invented one — so the files also state it in prose. What is checkable is the domain:
 * fixtures may only reference the names RFC 2606 reserves for documentation, which means a
 * paste from anyone's browsing history trips this test before it reaches a commit.
 *
 * WHY A FILE LIST AND NOT `tests/**`: the two places real hostnames legitimately appear are
 * `public/filters/supplement.txt` — a list of real sites is what a filter list *is* — and
 * whatever the probe script downloads at runtime, which is never committed. The remaining
 * older test files use throwaway names like `a.com` and `e.com` that are also real
 * registrations; converting all ~200 of them is worth doing, but it is not this change, and
 * a scan that quietly excluded them would be worse than one that names what it covers.
 */
const FIXTURE_FILES = [
  'scripts/layout-probe.html',
  'tests/convert-legacy.test.ts',
  'tests/filters.test.ts',
  'tests/normalize.test.ts',
  'tests/organize.test.ts',
  'tests/registrable.test.ts',
  'tests/subscriptions.test.ts',
];

const ALLOWED = new Set(['localhost']);

/**
 * RFC 2606 reserves `example.com` / `.org` / `.net` and the whole `.example` TLD, and the
 * interesting fixtures are the adversarial near-misses — `notexample.com`,
 * `example.computer`, `counterexample.com` — which exist precisely to prove a pattern does
 * NOT over-match. So the test is "the name says example somewhere", which accepts all of
 * those while still tripping on anything out of a real history: `x.com`, `zhihu.com`,
 * `news.ycombinator.com`, and the `a.com` / `e.com` throwaways too.
 */
function isSynthetic(host: string): boolean {
  return host.includes('example') || ALLOWED.has(host);
}

/**
 * `https://host/…` — the form real URLs take in the converter fixture.
 *
 * The optional `userinfo@` is skipped rather than captured: it is credentials, not a hostname, so
 * `https://user:pw@lists.example/a` used to be reported as the host `user` while the real host
 * went unchecked — a false positive that hid a false negative.
 */
const WITH_SCHEME = /https?:\/\/(?:[^/?#\s@]*@)?([a-z0-9.-]+)/gi;
/**
 * `host/…` with no scheme — the form `.row__loc` renders in the probe. Requiring the
 * trailing slash is what separates a hostname from a dotted member expression
 * (`store.importPayload`) or a relative import (`../components/app.css`).
 */
const BARE_HOST = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\//gi;

function offendingHosts(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of [WITH_SCHEME, BARE_HOST]) {
    for (const match of text.matchAll(pattern)) {
      const host = match[1];
      if (!host) continue;
      const lower = host.toLowerCase();
      if (!isSynthetic(lower)) found.add(lower);
    }
  }
  return [...found].sort();
}

test('layout, converter and filter fixtures reference only synthetic domains', () => {
  const offenders: string[] = [];
  for (const relative of FIXTURE_FILES) {
    const text = readFileSync(resolve(process.cwd(), relative), 'utf8');
    for (const host of offendingHosts(text)) offenders.push(`${relative}: ${host}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `fixtures must use RFC 2606 reserved domains only, found:\n  ${offenders.join('\n  ')}`,
  );
});

test('the check itself would catch a pasted real URL', () => {
  // Without this, a broken regex would turn the test above into one that passes no matter
  // what lands in the fixtures.
  assert.deepEqual(offendingHosts('see https://x.com/someone for details'), ['x.com']);
  assert.deepEqual(offendingHosts('<span class="row__loc">news.ycombinator.com/item</span>'), [
    'news.ycombinator.com',
  ]);
  assert.deepEqual(offendingHosts('a link to https://example.com/x'), [], 'reserved domains pass');
  assert.deepEqual(
    offendingHosts('https://notexample.com/a and https://example.computer/b'),
    [],
    'the adversarial near-misses the filter tests need are synthetic too',
  );
  // The throwaway names older fixtures use are real registrations, and the scan says so.
  assert.deepEqual(offendingHosts('https://a.com/x https://e.com/y'), ['a.com', 'e.com']);

  // The trailing-slash requirement is load-bearing: these three are not hostnames.
  assert.deepEqual(offendingHosts('await store.importPayload(payload)'), []);
  assert.deepEqual(offendingHosts('<link rel="stylesheet" href="../components/app.css" />'), []);
  assert.deepEqual(offendingHosts('import { convertLegacyExport } from "./convert-legacy.mjs"'), []);

  // Credentials are not a hostname. Reporting `user` here used to mean the real host after the
  // `@` was never looked at, so the false positive was hiding a false negative.
  assert.deepEqual(offendingHosts('https://user:pw@lists.example/a.txt'), []);
  assert.deepEqual(offendingHosts('https://user:pw@x.com/a'), ['x.com']);
  assert.deepEqual(offendingHosts('https://someone@example.org/a'), []);
});
