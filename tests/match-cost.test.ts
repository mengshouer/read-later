import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { compileFilters, countSkipped } from '../utils/filters';
import { normalizeUrl } from '../utils/normalize';
import { findUnsafeRegex } from '../utils/regex-safety';
import { parseListMeta } from '../utils/subscriptions';

/**
 * Cost, not correctness — the one thing the rest of the suite never asserted.
 *
 * Every other test here asks "does this rule remove the right parameter?", and
 * `tests/ubo-differential.test.ts` asks "does uBO agree?". Neither notices a rule that
 * produces the right answer after twenty seconds, which is indistinguishable from a hung
 * extension: `normalizeUrl` runs synchronously on the save path (`background.ts`), on import,
 * and once per stored item inside `planRecompute`.
 *
 * The inputs below are not hypothetical. Filter text arrives from two untrusted places — the
 * rules the user types, and the body of any subscribed list, which `permissionOrigin` will
 * fetch over cleartext http and which auto-update re-fetches daily with nobody watching. Each
 * case here was measured hanging before the fix that accompanies it, and the recorded timing
 * is in the comment so a future change that reintroduces the blowup is legible rather than
 * merely red.
 *
 * WHY WALL-CLOCK ASSERTIONS ARE ACCEPTABLE HERE, given the suite is otherwise deterministic:
 * the gap being defended is three to five ORDERS of magnitude (0 ms vs 22,900 ms), so the
 * budgets below sit ~50x above the observed cost. A slow CI runner cannot cross that; only a
 * genuine return to super-linear behaviour can. Anything tighter would be a flaky test, and a
 * flaky test in this position would eventually be deleted rather than believed.
 */
const BUDGET_MS = 500;

function timed(work: () => void): number {
  const started = Date.now();
  work();
  return Date.now() - started;
}

test('a header line with no colon cannot make parseListMeta super-linear', () => {
  // `\s*` and `[A-Za-z ]` in the old single-regex version both matched a space, so a line the
  // engine can never complete forced it to try every split point. Measured before the fix:
  // n=500 -> 232 ms, n=1000 -> 370 ms, n=2000 -> 2,865 ms, n=4000 -> 22,895 ms. After: 0 ms.
  const elapsed = timed(() => parseListMeta('!' + ' '.repeat(4000) + 'X'));
  assert.ok(elapsed < BUDGET_MS, `4000-space header took ${elapsed}ms, budget ${BUDGET_MS}ms`);
});

test('a long run of header-shaped lines stays linear in total', () => {
  // `split(/\r?\n/, 100)` caps the line COUNT, which is why the single-line case above is the
  // dangerous one — but the cap must not be the only thing standing between us and a hang.
  const text = Array.from({ length: 100 }, () => '!' + ' '.repeat(2000) + 'X').join('\n');
  const elapsed = timed(() => parseListMeta(text));
  assert.ok(elapsed < BUDGET_MS, `100 x 2000-space headers took ${elapsed}ms, budget ${BUDGET_MS}ms`);
});

test('the awkward real-world header spellings still parse after the rewrite', () => {
  // Equivalence cases that a mismatch actually caught while replacing the regex. The old
  // `\s*…\s*` pair stripped whitespace on BOTH sides of the name, so a tab before the colon
  // is a real header and trimming only the front silently dropped it.
  assert.equal(parseListMeta('! Title\t: Tabbed').title, 'Tabbed');
  assert.equal(parseListMeta('! Title \t : Spaced').title, 'Spaced');
  assert.equal(parseListMeta('!Title:NoSpace').title, 'NoSpace');
  assert.equal(parseListMeta('!  Title  :  padded  ').title, 'padded');
  // Whitespace INSIDE the name was never accepted, because `[A-Za-z ]+?` matched no tab.
  assert.equal(parseListMeta('! Ti\ttle: X').title, null);
  // A header with nothing after the colon was never a header, because the old value was `(.+)`.
  assert.equal(parseListMeta('! Title:').title, null);
  assert.equal(parseListMeta('! Title:    ').title, null);
  // And the ordinary spellings, which the rest of the suite already relies on.
  assert.equal(parseListMeta('! Expires: 5 days').expiresHours, 120);
  assert.equal(parseListMeta('!Expires:12 hours').expiresHours, 12);
});

// ---------------------------------------------------------------- filter matching

/** A URL whose query is long enough to make an exponential matcher diverge, and no longer. */
const PADDED = 'https://example.com/article?id=' + 'a'.repeat(50);

function compile(text: string) {
  return compileFilters([{ id: 'cost', text }]);
}

test('a $removeparam value with a nested quantifier is refused rather than compiled', () => {
  // 21 characters, and with an empty pattern half it lands in `index.always` — so before the
  // guard it ran on EVERY saved URL. `compileFilters` reported `active: 1, skipped: 0` in 1 ms
  // and then `normalizeUrl` never returned; killed at 15 s.
  const compiled = compile('$removeparam=/(a+)+z/');
  assert.equal(compiled.active, 0, 'the rule must not become active');
  assert.equal(countSkipped(compiled).unsupported, 1);
  // `unsupported`, not `invalid`: uBO honours this rule and we are declining to, which is
  // exactly how that bucket is defined. `invalid` means malformed, and this is well-formed.
  assert.equal(compiled.skipped[0]?.bucket, 'unsupported');
  assert.match(compiled.skipped[0]?.reason ?? '', /^unsafe regex:/);
  const elapsed = timed(() => normalizeUrl(PADDED, compiled));
  assert.ok(elapsed < BUDGET_MS, `matching took ${elapsed}ms, budget ${BUDGET_MS}ms`);
});

test('a /…/ pattern with a nested quantifier is refused rather than compiled', () => {
  // Same defect on the other arbitrary-regex path; this one reaches `index.generic`.
  const compiled = compile('/(?:a+)+z/$removeparam=fbclid');
  assert.equal(compiled.active, 0);
  assert.equal(compiled.skipped[0]?.bucket, 'unsupported');
  const elapsed = timed(() => normalizeUrl(PADDED, compiled));
  assert.ok(elapsed < BUDGET_MS, `matching took ${elapsed}ms, budget ${BUDGET_MS}ms`);
});

test('adjacent variable quantifiers cannot bypass the regex guard', () => {
  // Star-height alone only sees nesting. This equally hostile flat form used to pass the guard,
  // then took seconds on the same 50-character subject because every `a*` can surrender input to
  // every later `a*` before the final `z` fails.
  const compiled = compile('$removeparam=/a*a*a*a*a*a*z/');
  assert.equal(compiled.active, 0);
  assert.match(compiled.skipped[0]?.reason ?? '', /adjacent variable quantifiers/);
  const elapsed = timed(() => normalizeUrl(PADDED, compiled));
  assert.ok(elapsed < BUDGET_MS, `matching took ${elapsed}ms, budget ${BUDGET_MS}ms`);
});

test('quantified alternation and backreferences are refused conservatively', () => {
  // `(a|aa)+z` took seconds on fewer than 50 characters. Backreferences make the language depend
  // on captured input, which this structural scanner cannot bound, so they are declined too.
  for (const source of ['(a|aa)+z', String.raw`(a+)\1z`]) {
    const compiled = compile(`$removeparam=/${source}/`);
    assert.equal(compiled.active, 0, source);
    assert.equal(compiled.skipped[0]?.bucket, 'unsupported', source);
  }
});

test('the wildcard rule with no regex metacharacters is honoured, not refused', () => {
  // The load-bearing case. This rule contains only the documented `*`, so refusing it would be
  // a real loss of function — and no `*`-count cap can separate it from a legitimate rule
  // (measured: a cap of 3 rejects nothing in the AdGuard list yet still permits 84 s, and the
  // only safe cap of 1 discards 20 real rules). It is the block matcher, not a rejection, that
  // makes this safe, so the assertion is that the rule STAYS ACTIVE and answers instantly.
  const compiled = compile('*a*a*a*a*a*a*a*a*a*a*a*a*z$removeparam=fbclid');
  assert.equal(compiled.active, 1, 'a legitimate wildcard rule must not be rejected');
  assert.equal(compiled.skipped.length, 0);
  const elapsed = timed(() => normalizeUrl(PADDED, compiled));
  assert.ok(elapsed < BUDGET_MS, `matching took ${elapsed}ms, budget ${BUDGET_MS}ms`);
});

test('wildcard cost stays flat as the URL grows', () => {
  // The regex version was exponential in URL length, so the shape of the curve is the property
  // worth pinning, not any single measurement. 4,000 characters was 84 s under a `*`-cap of 3.
  const compiled = compile('*a*a*a*a*a*a*a*a*a*a*a*a*z$removeparam=fbclid');
  for (const padding of [50, 500, 4000]) {
    const url = 'https://example.com/a?id=' + 'a'.repeat(padding);
    const elapsed = timed(() => normalizeUrl(url, compiled));
    assert.ok(elapsed < BUDGET_MS, `${padding} chars of padding took ${elapsed}ms`);
  }
});

test('wildcard rules still remove exactly what they removed before', () => {
  // Semantics, not cost: the block matcher reimplements pattern matching for every non-regex
  // pattern, so a silent behaviour change here would produce wrong urlKeys — and urlKey is the
  // storage primary key, so items would split or merge. `tests/ubo-differential.test.ts` and
  // `scripts/filter-probe.mjs` are the thorough versions of this check; these are the cases
  // that exercise the block path specifically.
  const cases: Array<[string, string, string]> = [
    ['*a*z$removeparam=id', 'https://example.com/a-to-z?id=1&keep=2', 'https://example.com/a-to-z?keep=2'],
    // no match => the query is untouched
    ['*q*q*q$removeparam=id', 'https://example.com/a?id=1', 'https://example.com/a?id=1'],
    // `^` separator, including its end-of-URL form
    ['||example.com^$removeparam=id', 'https://example.com/a?id=1&b=2', 'https://example.com/a?b=2'],
    // A `||` rule must not fire through userinfo on a completely different host. Note the key
    // drops the credentials — `normalizeUrl` builds it from scheme/host/port/path/query, so
    // `example.com@` is not in it — and what this asserts is that `id` SURVIVES, i.e. the rule
    // for example.com did not match a request to evil.example.net.
    ['||example.com^$removeparam=id', 'https://example.com@evil.example.net/a?id=1', 'https://evil.example.net/a?id=1'],
    // subdomain, which the `||` anchor reaches via its optional label prefix
    ['||example.com^$removeparam=id', 'https://sub.example.com/a?id=1', 'https://sub.example.com/a'],
    // a trailing `|` anchors the end of the URL, so this must NOT match
    ['||example.com/a|$removeparam=id', 'https://example.com/a?id=1', 'https://example.com/a?id=1'],
    // Domain anchor followed immediately by end anchor: no body means no match on a real URL.
    ['|||$removeparam=id', 'https://example.com/a?id=1', 'https://example.com/a?id=1'],
    // case folding is preserved
    ['||example.com/track/$removeparam=id', 'https://example.com/TRACK/x?id=1', 'https://example.com/TRACK/x'],
  ];
  for (const [rule, url, expected] of cases) {
    const got = normalizeUrl(url, compile(rule));
    assert.equal(got?.urlKey, expected, rule);
  }
});

test('the regex guard accepts every regex the differential suite relies on', () => {
  // A false positive here silently disables a legitimate rule, which is worse than the hang it
  // is defending against. Measured over the live AdGuard list this rejects 0 of 45 regex values
  // and 0 of 2,507 rules; these are the ones pinned by tests/ubo-differential.test.ts.
  for (const safe of ['%20', '=https?:', '^utm_', 'utm_', 'example\\.com\\/c\\d', '^https:\\/\\/example\\.com\\/c\\d+\\/a']) {
    assert.equal(findUnsafeRegex(safe), null, safe);
  }
  // A wrapper that can run at most once does not add a second repetition choice.
  for (const safe of ['(?:a+)?', '(?:a+){1}', '(?:a{1000}){2}']) {
    assert.equal(findUnsafeRegex(safe), null, safe);
  }
  // And it must still catch nesting hidden behind a harmless group or a lookaround.
  for (const unsafe of [
    '(a+)+z',
    '((a+))+',
    '(?=(a+)+z)',
    '(?:a{0,50}){0,50}',
    'a*a*a*a*a*a*z',
    'a*(?:)a*',
    String.raw`\x61*\x61*\x61*\x61*z`,
    String.raw`\u0061*\u0061*\u0061*\u0061*z`,
    '(a|aa)+z',
    String.raw`(a+)\1z`,
  ]) {
    assert.ok(findUnsafeRegex(unsafe), unsafe);
  }
});
