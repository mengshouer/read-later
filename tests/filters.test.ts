import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type { CompiledFilters } from '../utils/filters';
import {
  compileFilters,
  countSkipped,
  decideQuery,
  formatLineRanges,
  groupSkipped,
  hostMatches,
  queryParamsOf,
} from '../utils/filters';

/** Param names that survive, in URL order. */
function survivors(compiled: CompiledFilters, rawUrl: string): string[] {
  const url = new URL(rawUrl);
  const params = queryParamsOf(url);
  const decision = decideQuery(compiled, rawUrl, url.hostname, params);
  return params.filter((_, i) => decision.keep[i]).map((p) => p.name);
}

function keep(text: string, rawUrl: string): string[] {
  return survivors(compileFilters([{ id: 'test', text }]), rawUrl);
}

const URL_A = 'https://example.com/a?v=1&utm_source=x&fbclid=y';

// ---------------------------------------------------------------- nothing built in

test('with no filters every param is part of the identity', () => {
  assert.deepEqual(keep('', URL_A), ['v', 'utm_source', 'fbclid']);
});

test('comments and headers are skipped, and `#` is NOT a comment character', () => {
  const compiled = compileFilters([
    {
      id: 'test',
      text: [
        '[Adblock Plus 2.0]',
        '! Title: Example list',
        '! Expires: 5 days',
        '',
        '$removeparam=fbclid',
      ].join('\n'),
    },
  ]);
  assert.equal(compiled.active, 1);
  assert.equal(compiled.skipped.length, 0, 'header and `!` lines are not reported as problems');
  // `#` starts a cosmetic filter in this syntax, so the old DSL's `#` comments would
  // silently become filters if we kept treating them as comments.
  const hashed = compileFilters([{ id: 'test', text: '# strip: utm_*' }]);
  assert.equal(hashed.active, 0);
  assert.equal(hashed.skipped.length, 1);
});

// ---------------------------------------------------------------- value forms

test('a plain name matches that param exactly, and case-sensitively like uBO', () => {
  assert.deepEqual(keep('$removeparam=fbclid', URL_A), ['v', 'utm_source']);
  assert.deepEqual(
    keep('$removeparam=FBCLID', URL_A),
    ['v', 'utm_source', 'fbclid'],
    'uBO compares param names verbatim; folding case here would strip more than uBO does',
  );
});

test('a regex value is tested against `name=value`, not the name alone', () => {
  // The single easiest place to diverge from uBO, and invisible if only name-matching
  // rules are tested: this regex can ONLY match through the value.
  assert.deepEqual(keep('$removeparam=/=secret$/', 'https://example.com/?token=secret&keep=1'), [
    'keep',
  ]);
  assert.deepEqual(keep('$removeparam=/=secret$/', 'https://example.com/?token=other&keep=1'), [
    'token',
    'keep',
  ]);
  // And the common prefix form still works through the name half of the pair.
  assert.deepEqual(keep('$removeparam=/^utm_/', URL_A), ['v', 'fbclid']);
});

test('a bare $removeparam clears the whole query', () => {
  assert.deepEqual(keep('||example.com^$removeparam', URL_A), []);
});

test('an inverted name keeps only that param — the replacement for `keep:`', () => {
  assert.deepEqual(keep('||example.com^$removeparam=~v', URL_A), ['v']);
});

test('an inverted regex keeps only the matching params', () => {
  assert.deepEqual(
    keep('||example.com^$removeparam=~/^(v|t)=/', 'https://example.com/?v=1&t=2&utm_source=x'),
    ['v', 't'],
  );
});

test('removal is additive across lines, so a multi-line list composes', () => {
  // The old DSL lost the first of two same-specificity `strip:` lines outright (D33).
  // Additive-plus-exceptions has no ladder to get wrong, so this is now structural.
  assert.deepEqual(keep('$removeparam=utm_source\n$removeparam=fbclid', URL_A), ['v']);
});

// ---------------------------------------------------------------- patterns

test('`||host^` covers the apex and every subdomain, and nothing else', () => {
  const text = '||example.com^$removeparam=id';
  assert.deepEqual(keep(text, 'https://example.com/?id=1'), []);
  assert.deepEqual(keep(text, 'https://a.b.example.com/?id=1'), []);
  assert.deepEqual(keep(text, 'https://example.org/?id=1'), ['id']);
  assert.deepEqual(keep(text, 'https://notexample.com/?id=1'), ['id']);
});

test('`||host` without the separator keeps matching into the label, like uBO', () => {
  // `^` is what makes the host exact. Treating the two as equivalent would be a silent
  // divergence in the safer direction for us but the wrong one for portability.
  assert.deepEqual(keep('||example.com^$removeparam=id', 'https://example.computer/?id=1'), ['id']);
  assert.deepEqual(keep('||example.com$removeparam=id', 'https://example.computer/?id=1'), []);
});

test('a path in the pattern scopes the rule to that path', () => {
  const text = '||example.com/track/$removeparam=id';
  assert.deepEqual(keep(text, 'https://example.com/track/x?id=1'), []);
  assert.deepEqual(keep(text, 'https://example.com/other?id=1'), ['id']);
});

test('a bare substring pattern matches anywhere in the URL', () => {
  // 48 rules of the real AdGuard list are this shape, matching the query string itself.
  const text = '&af_xp=$removeparam=af_xp';
  assert.deepEqual(keep(text, 'https://example.com/?a=1&af_xp=y'), ['a']);
  assert.deepEqual(keep(text, 'https://example.com/?af_xp=y'), ['af_xp'], 'no leading &, no match');
});

test('`*` matches every URL', () => {
  assert.deepEqual(keep('*$removeparam=id', 'https://example.net/?id=1&b=2'), ['b']);
});

// ---------------------------------------------------------------- $domain / denyallow

test('$domain scopes a global rule, and `~` excludes', () => {
  const text = '$removeparam=id,domain=example.com|example.org';
  assert.deepEqual(keep(text, 'https://example.com/?id=1'), []);
  assert.deepEqual(keep(text, 'https://sub.example.org/?id=1'), []);
  assert.deepEqual(keep(text, 'https://example.net/?id=1'), ['id']);
  assert.deepEqual(keep('$removeparam=id,domain=~example.com', 'https://example.com/?id=1'), ['id']);
  assert.deepEqual(keep('$removeparam=id,domain=~example.com', 'https://example.net/?id=1'), []);
});

test('the `example.*` entity form matches any TLD', () => {
  const text = '$removeparam=id,domain=example.*';
  assert.deepEqual(keep(text, 'https://example.com/?id=1'), []);
  assert.deepEqual(keep(text, 'https://example.org/?id=1'), []);
  assert.deepEqual(keep(text, 'https://other.example/?id=1'), ['id']);
  assert.equal(hostMatches('example.*', 'sub.example.co'), true);
  assert.equal(hostMatches('example.*', 'counterexample.com'), false);
});

test('$denyallow exempts the listed hosts from an otherwise matching rule', () => {
  const text = '$removeparam=id,denyallow=example.org,domain=example.*';
  assert.deepEqual(keep(text, 'https://example.com/?id=1'), []);
  assert.deepEqual(keep(text, 'https://example.org/?id=1'), ['id']);
});

test('$denyallow without $domain voids the whole filter, exactly as uBO does', () => {
  // uBO's parser: `realBad = … || getBranchFromType(NODE_TYPE_NET_OPTION_NAME_FROM) === 0`.
  // AdGuard's uBO-flavoured list ships 21 rules in this shape — `$removeparam=utm_source`
  // among them — so honouring them would strip more than uBO does from the same list.
  const text = '$denyallow=example.org,removeparam=utm_source';
  const compiled = compileFilters([{ id: 'test', text }]);
  assert.equal(compiled.active, 0);
  assert.equal(compiled.skipped[0]?.bucket, 'invalid');
  assert.equal(compiled.skipped[0]?.reason, '$denyallow without $domain');
  assert.deepEqual(keep(text, 'https://example.com/?utm_source=x'), ['utm_source']);
});

// ---------------------------------------------------------------- exceptions

test('an @@ exception cancels a removal by value text, not by re-matching params', () => {
  // uBO keys removals and exceptions on the `$removeparam` VALUE TEXT and cancels only on exact
  // equality (`matchAndFetchModifiers`: `if (toAdd.has(key)) toAdd.delete(key)`), so an exception
  // naming one parameter does NOT carve that parameter out of a regex removal. Resolving it per
  // parameter kept `utm_source`, which uBO removes — verified against the real engine in
  // `tests/ubo-differential.test.ts`.
  const named = '$removeparam=/^utm_/\n@@||example.com^$removeparam=utm_source';
  assert.deepEqual(keep(named, 'https://example.com/?utm_source=x&utm_medium=y'), []);
  assert.deepEqual(keep(named, 'https://example.org/?utm_source=x&utm_medium=y'), []);

  // Identical value text does cancel, and then nothing is removed on that host at all.
  const matching = '$removeparam=/^utm_/\n@@||example.com^$removeparam=/^utm_/';
  assert.deepEqual(keep(matching, 'https://example.com/?utm_source=x&utm_medium=y'), [
    'utm_source',
    'utm_medium',
  ]);
  assert.deepEqual(keep(matching, 'https://example.org/?utm_source=x&utm_medium=y'), []);

  // And an exception cancels only the rule it matches, leaving other removals alone.
  const two = '$removeparam=fbclid\n$removeparam=gclid\n@@||example.com^$removeparam=fbclid';
  assert.deepEqual(keep(two, 'https://example.com/?fbclid=a&gclid=b&id=7'), ['fbclid', 'id']);
});

test('a bare @@ exception takes the whole host out of scope — the escape hatch', () => {
  const text = '$removeparam\n@@||example.com^$removeparam';
  assert.deepEqual(keep(text, 'https://example.com/?v=1&utm_source=x'), ['v', 'utm_source']);
  assert.deepEqual(keep(text, 'https://example.org/?v=1'), []);
});

// ---------------------------------------------------------------- request semantics

test('a saved URL is a first-party top-level document, so type options decide correctly', () => {
  const cases: Array<[string, boolean]> = [
    ['||example.com^$document,removeparam=id', true],
    ['||example.com^$doc,removeparam=id', true],
    ['||example.com^$removeparam=id,~third-party', true],
    ['||example.com^$xhr,removeparam=id', false],
    ['||example.com^$script,removeparam=id', false],
    ['||example.com^$image,removeparam=id', false],
    ['||example.com^$subdocument,removeparam=id', false],
    ['||example.com^$removeparam=id,third-party', false],
    ['||example.com^$removeparam=id,3p', false],
    ['||example.com^$removeparam=id,~document', false],
    ['||example.com^$removeparam=id,method=post', false],
    ['||example.com^$removeparam=id,method=get', true],
    ['||example.com^$app=someapp.exe,removeparam=id', false],
  ];
  for (const [text, shouldApply] of cases) {
    const kept = keep(text, 'https://example.com/?id=1');
    assert.deepEqual(kept, shouldApply ? [] : ['id'], text);
  }
});

test('a rule that cannot reach us is reported as not-applicable, not as broken', () => {
  const compiled = compileFilters([{ id: 'test', text: '||example.com^$xhr,removeparam=id' }]);
  assert.equal(compiled.active, 0);
  assert.equal(compiled.skipped[0]?.bucket, 'not-applicable');
});

// ---------------------------------------------------------------- classification

test('the three buckets separate our gaps from correct inertness from bad syntax', () => {
  const compiled = compileFilters([
    {
      id: 'test',
      text: [
        '$removeparam=fbclid', // active
        '||example.com^$xhr,removeparam=id', // not-applicable: wrong request type
        '||example.com^', // not-applicable: blocking rule, nothing to remove
        'example.com##.ad', // not-applicable: cosmetic
        '||example.com^$removeparam=id,badfilter', // unsupported: OUR gap
        '||example.com^$removeparam=id,header=x', // unsupported: cannot evaluate
        '||example.com^$removeparam=~', // invalid
      ].join('\n'),
    },
  ]);
  assert.equal(compiled.active, 1);
  const counts = countSkipped(compiled);
  assert.equal(counts['not-applicable'], 3);
  assert.equal(counts.unsupported, 2);
  assert.equal(counts.invalid, 1);
  // The distinction is the whole point: "not-applicable" means we judged correctly,
  // "unsupported" means uBO would do something we cannot. Merging them would leave no
  // way to tell a working subset from a hole.
  const unsupported = compiled.skipped.filter((s) => s.bucket === 'unsupported');
  assert.deepEqual(unsupported.map((s) => s.reason).sort(), ['$badfilter', '$header']);
});

test('every skipped line carries its source, line number and text', () => {
  const compiled = compileFilters([{ id: 'mylist', text: '!x\n||example.com^$removeparam=id,badfilter' }]);
  assert.deepEqual(compiled.skipped, [
    {
      source: 'mylist',
      line: 2,
      raw: '||example.com^$removeparam=id,badfilter',
      bucket: 'unsupported',
      reason: '$badfilter',
    },
  ]);
});

test('skipped lines group by cause, and report the params rather than the raw text', () => {
  // 21 lines sharing one cause are one finding, not 21 problems — and a real list makes
  // the raw text useless anyway: AdGuard's utm_campaign rule carries ~200 ccTLDs on one
  // line, which turned the options page into a wall of text.
  const long = `$denyallow=${Array.from({ length: 40 }, (_, i) => `site${i}.example`).join('|')},removeparam=utm_campaign`;
  const compiled = compileFilters([
    {
      id: 'list',
      text: [
        '$denyallow=a.example,removeparam=utm_source',
        '$denyallow=b.example,removeparam=utm_medium',
        long,
        '||example.com^$removeparam=id,badfilter',
      ].join('\n'),
    },
  ]);
  const groups = groupSkipped(compiled);
  assert.equal(groups.length, 2, 'one group per cause');
  const denyallow = groups.find((g) => g.reason === '$denyallow without $domain');
  assert.equal(denyallow?.count, 3);
  assert.deepEqual(denyallow?.params, ['utm_source', 'utm_medium', 'utm_campaign']);
  assert.deepEqual(denyallow?.lines, [1, 2, 3]);
  assert.equal(groups.find((g) => g.reason === '$badfilter')?.count, 1);

  // A comma inside a regex value is not an option separator, and the reported parameter must not
  // be truncated at it: `[^,]*` used to show the reader `/^(a` as what the line costs them.
  const commas = compileFilters([
    { id: 'list', text: '$removeparam=/^(a,b)$/,badfilter\n||example.com^$removeparam=/x,y/,badfilter' },
  ]);
  assert.deepEqual(groupSkipped(commas).find((g) => g.reason === '$badfilter')?.params, [
    '/^(a,b)$/',
    '/x,y/',
  ]);

  // Truncation, checked on a group whose only member is the long line.
  const alone = groupSkipped(compileFilters([{ id: 'list', text: long }]));
  assert.ok(long.length > 121, 'the fixture really is long');
  assert.ok((alone[0]?.sample.length ?? 0) <= 121);
  assert.ok(alone[0]?.sample.endsWith('…'));
  assert.deepEqual(alone[0]?.params, ['utm_campaign'], 'the param survives the truncation');
});

test('line numbers collapse into ranges', () => {
  assert.equal(formatLineRanges([484, 485, 486, 490]), '484–486, 490');
  assert.equal(formatLineRanges([7]), '7');
  assert.equal(formatLineRanges([3, 1, 2]), '1–3');
  assert.equal(formatLineRanges([]), '');
});

test('a hit names the list and line it came from, for the tester', () => {
  const compiled = compileFilters([
    { id: 'subscription', text: '$removeparam=utm_source' },
    { id: 'mine', text: '@@||example.com^$removeparam=utm_source' },
  ]);
  const url = new URL('https://example.com/?utm_source=x');
  const decision = decideQuery(compiled, url.href, url.hostname, queryParamsOf(url));
  assert.equal(decision.sparedBy[0]?.filter.source, 'mine');
  assert.equal(decision.sparedBy[0]?.filter.line, 1);
  assert.equal(decision.removedBy.length, 0);

  const url2 = new URL('https://example.org/?utm_source=x');
  const plain = decideQuery(compiled, url2.href, url2.hostname, queryParamsOf(url2));
  assert.equal(plain.removedBy[0]?.filter.source, 'subscription');
  assert.equal(plain.removedBy[0]?.param, 'utm_source');
});

// ---------------------------------------------------------------- the host index

test('the host index and a plain linear scan agree on every URL', () => {
  // An index bug drops rules silently — no single-rule test would notice, because each
  // rule is correct in isolation. This compares the indexed path against the same
  // filters forced through the regex path.
  const text = [
    '$removeparam=fbclid',
    '*$removeparam=gclid',
    '||example.com^$removeparam=id',
    '||sub.example.com^$removeparam=sid',
    '||example.org^$removeparam',
    '||example.net/track/$removeparam=t',
    '&af_xp=$removeparam=af_xp',
    '$removeparam=id,domain=example.co',
    '@@||keep.example.com^$removeparam=id',
    '@@||example.org^$removeparam',
  ].join('\n');
  const indexed = compileFilters([{ id: 'test', text }]);
  const linear = compileFilters([{ id: 'test', text }], { noIndex: true });
  assert.equal(indexed.active, linear.active);
  assert.equal(indexed.block.byHost.size > 0, true, 'the indexed build really is indexed');
  assert.equal(linear.block.byHost.size, 0, 'the linear build really is not');

  const urls = [
    'https://example.com/?id=1&fbclid=2&gclid=3',
    'https://sub.example.com/?id=1&sid=2',
    'https://deep.sub.example.com/?sid=1&other=2',
    'https://keep.example.com/?id=1&fbclid=2',
    'https://example.org/?id=1&anything=2',
    'https://example.net/track/x?t=1&u=2',
    'https://example.net/other?t=1',
    'https://example.co/?id=1',
    'https://example.computer/?id=1',
    'https://other.example/?a=1&af_xp=2',
    'https://other.example/?af_xp=2',
    'https://example.com/',
  ];
  for (const url of urls) {
    assert.deepEqual(survivors(indexed, url), survivors(linear, url), url);
  }
});

// ---------------------------------------------------------------- query extraction

test('queryParamsOf exposes what each consumer needs, with uBO’s own asymmetry', () => {
  const params = queryParamsOf(new URL('https://example.com/?a=x%20y&b=1+2&flag&c=%2F&utm%5Fd=1'));
  assert.deepEqual(
    params.map((p) => [p.name, p.value, p.rawKey, p.pair]),
    [
      // `pair` is `rawKey=decodeURIComponent(rawValue)` — uBO leaves the key raw and decodes the
      // value exactly once before testing a regex against the two joined.
      ['a', 'x y', 'a', 'a=x y'],
      // `+` is a space to the URL parser but not to `decodeURIComponent`, so uBO sees it verbatim.
      ['b', '1 2', 'b', 'b=1+2'],
      // A valueless param is `flag=` for matching, which is what uBO records for it too.
      ['flag', '', 'flag', 'flag='],
      ['c', '/', 'c', 'c=/'],
      // The raw key is what a `$removeparam=name` is compared against, so an encoded underscore
      // is NOT the same parameter as a literal one.
      ['utm_d', '1', 'utm%5Fd', 'utm%5Fd=1'],
    ],
  );
});

test('a regex sees the decoded value and the raw key, as uBO does', () => {
  // Both directions, both verified against the real engine in `tests/ubo-differential.test.ts`.
  // Testing the raw pair instead over-removed here…
  assert.deepEqual(keep('$removeparam=/%20/', 'https://example.com/?a=x%20y&b=z'), ['a', 'b']);
  // …and under-removed here, because the pattern describes what the escape sequence stands for.
  assert.deepEqual(
    keep('$removeparam=/=https?:/', 'https://example.com/?r=https%3A%2F%2Fx.example&b=z'),
    ['b'],
  );
  // A name is compared against the raw key, so these two rules are not interchangeable.
  assert.deepEqual(keep('$removeparam=utm_source', 'https://example.com/?utm%5Fsource=x&b=1'), [
    'utm_source',
    'b',
  ]);
  assert.deepEqual(keep('$removeparam=utm%5Fsource', 'https://example.com/?utm%5Fsource=x&b=1'), [
    'b',
  ]);
});

test('only uBO’s own regex flags are recognised; anything else is a literal name', () => {
  // `/^\/(.+)\/(i)?$/` is uBO's whole grammar for a regex value. `/utm_/g` fails it, falls through
  // to being a parameter literally named `/utm_/g`, and therefore removes nothing — whereas
  // honouring the flag made `.test()` stateful and removed every other parameter.
  assert.deepEqual(keep('$removeparam=/utm_/g', 'https://example.com/?utm_a=1&utm_b=2&utm_c=3'), [
    'utm_a',
    'utm_b',
    'utm_c',
  ]);
  assert.deepEqual(keep('$removeparam=/utm_/', 'https://example.com/?utm_a=1&utm_b=2&utm_c=3'), []);
  assert.deepEqual(keep('$removeparam=/utm_/i', 'https://example.com/?UTM_a=1&b=2'), ['b']);
  // Multiple values are refused outright by uBO, so the line cannot participate.
  assert.deepEqual(keep('$removeparam=a|b', 'https://example.com/?a=1&b=2'), ['a', 'b']);
});

test('a negated $method excludes rather than requires — a restore is always a GET', () => {
  // The oracle cannot settle this one: `fctxt.method` is an internal bit and `@gorhill/ubo-core`
  // exports no way to set it, so a `$method` rule is simply inert there. Asserted directly
  // instead. Reading the option-level `~` rather than each value's own made `$method=~post` look
  // like a positive list of one, and the rule was wrongly reported as not applicable.
  const applies = (rule: string) =>
    keep(rule, 'https://example.com/?id=1').length === 0;
  assert.equal(applies('||example.com^$removeparam=id,method=get'), true);
  assert.equal(applies('||example.com^$removeparam=id,method=~post'), true, '~post allows GET');
  assert.equal(applies('||example.com^$removeparam=id,method=get|head'), true);
  assert.equal(applies('||example.com^$removeparam=id,method=post'), false);
  assert.equal(applies('||example.com^$removeparam=id,method=~get'), false, '~get excludes GET');
});

test('an empty query short-circuits', () => {
  assert.deepEqual(keep('$removeparam', 'https://example.com/path'), []);
  assert.deepEqual(keep('$removeparam', 'https://example.com/path?'), []);
});
