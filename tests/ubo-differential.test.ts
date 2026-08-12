import { strict as assert } from 'node:assert';
import { beforeAll, test } from 'vitest';
import type { StaticNetFilteringEngine } from '@gorhill/ubo-core';
import { compileFilters, queryParamsOf } from '../utils/filters';
import { decideQueryFor } from '../utils/normalize';

/**
 * Differential tests against uBlock Origin's own engine.
 *
 * The promise this project makes is that a rule written in the options page also works pasted
 * into uBO. Only uBO can settle that, and several divergences survived for a long time precisely
 * because the one thing that checks it — `scripts/filter-probe.mjs` — runs against a live list and
 * therefore only ever exercises the rule shapes that list happens to use.
 *
 * So the shapes it does NOT use are pinned here instead, with the real engine as the oracle rather
 * than a hand-written expectation: several of these answers are counter-intuitive, and writing
 * down a belief about uBO would just bake in a new wrong answer.
 *
 * WHY THIS IS ALLOWED TO LIVE IN `pnpm test`, when the probe is not. The probe is nondeterministic
 * because it downloads a list that changes weekly with nobody's involvement — measured, 3,789 to
 * 3,792 lines between two runs an hour apart. This file has no network at all, and `ubo-core` is
 * pinned by the committed lockfile at 0.1.30, the newest release, published 2024-10. It can only
 * change when someone runs `pnpm update` and commits the result — and a red test at exactly that
 * moment is the signal you want, not noise.
 *
 * `@gorhill/ubo-core` is GPL-3.0 and this project is MIT: it is a devDependency, imported only
 * here and by the probe, and nothing in `.output/` links against it.
 *
 * Cost, measured: ~375 ms once for the import plus engine creation, then well under a millisecond
 * per query.
 */

type Engine = StaticNetFilteringEngine;

/**
 * One engine for the whole file: ubo-core throws `Only a single instance is supported.` on a
 * second `create()`. Rules are swapped per case with `useLists`, and every case uses a fresh URL
 * because uBO memoizes tokenization per URL — reusing one hands back an answer computed for the
 * previous rule set.
 */
let engine: Engine;

beforeAll(async () => {
  const { StaticNetFilteringEngine: Engine } = await import('@gorhill/ubo-core');
  engine = await Engine.create();
});

/** Serial, so a reused URL cannot pick up a cached verdict. */
let unique = 0;

async function compare(rules: string, target: string) {
  const url = new URL(target);
  url.pathname = `/c${++unique}${url.pathname}`;
  const fresh = url.href;

  const compiled = compileFilters([{ id: 'diff', text: rules }]);
  const verdict = decideQueryFor(fresh, compiled);
  const ours = verdict
    ? verdict.params.filter((_, i) => verdict.decision.keep[i]).map((p) => p.pair)
    : [];

  await engine.useLists([{ name: 'diff', raw: rules }]);
  const result = engine.filterQuery({ url: fresh, type: 'main_frame', originURL: fresh });
  const effective = result && result.redirectURL ? result.redirectURL : fresh;
  const theirs = queryParamsOf(new URL(effective)).map((p) => p.pair);

  return { ours: ours.join('&'), theirs: theirs.join('&'), compiled, url: fresh };
}

/** Asserts we and uBO keep exactly the same query, and reports both sides when we do not. */
async function agree(rules: string, target: string, note = '') {
  const { ours, theirs, url } = await compare(rules, target);
  assert.equal(
    ours,
    theirs,
    `${note || rules}\n  url  : ${url}\n  ours : ${ours || '(none)'}\n  uBO  : ${theirs || '(none)'}`,
  );
}

test('a regex value is matched against the DECODED name=value, as uBO does', async () => {
  // uBO decodes the value before testing: `for (const [key, raw] of params) { value =
  // decodeURIComponent(raw); re.test(`${key}=${value}`) }`. Testing the raw pair instead is wrong
  // in both directions — it over-removes when the pattern matches an escape sequence and
  // under-removes when it matches what that sequence stands for.
  await agree('$removeparam=/%20/', 'https://example.com/a?a=x%20y&b=z', 'over-removal');
  await agree(
    '$removeparam=/=https?:/',
    'https://example.com/a?r=https%3A%2F%2Fx.example&b=z',
    'under-removal',
  );
});

test('a parameter name is matched against the raw key, as uBO does', async () => {
  await agree('$removeparam=utm_source', 'https://example.com/a?utm%5Fsource=x&b=1');
  await agree('$removeparam=utm%5Fsource', 'https://example.com/a?utm%5Fsource=x&b=1');
});

test('an @@ exception is resolved by value string, as uBO does', async () => {
  // uBO keys its add/remove sets on the filter's value text and cancels by exact equality, so an
  // exception naming one parameter does not carve that parameter out of a regex removal.
  await agree(
    '$removeparam=/^utm_/\n@@||example.com^$removeparam=utm_source',
    'https://example.com/a?utm_source=x&utm_medium=y',
  );
  await agree(
    '$removeparam=/^utm_/\n@@||example.com^$removeparam=~utm_source',
    'https://example.com/a?utm_source=x&utm_medium=y',
  );
  await agree(
    '$removeparam=/^utm_/\n@@||example.com^$removeparam=/^utm_/',
    'https://example.com/a?utm_source=x&utm_medium=y',
    'an exception whose value matches exactly does spare',
  );
});

test('patterns match case-insensitively, as uBO does', async () => {
  await agree('||example.com/track/$removeparam=id', 'https://example.com/TRACK/x?id=1');
  await agree('||example.com/track/$removeparam=id', 'https://example.com/track/x?id=1');
});

test('a /regex/ pattern is honoured rather than escaped into a literal', async () => {
  await agree(String.raw`/^https:\/\/example\.com\/c\d+\/a/$removeparam=id`, 'https://example.com/a?id=1');
  await agree(String.raw`/example\.com\/c\d/$removeparam=/^utm_/`, 'https://example.com/a?utm_a=1&b=2');
});

test('an entity pattern does not match a host that merely starts with the stem', async () => {
  await agree('||example.*^$removeparam=id', 'https://example.com/a?id=1');
  await agree('||example.*^$removeparam=id', 'https://example.notasuffix.test/a?id=1');
});

test('popup-scoped rules do not apply to a saved document, as uBO does', async () => {
  await agree('||example.com^$popup,removeparam=id', 'https://example.com/a?id=1');
  await agree('||example.com^$document,removeparam=id', 'https://example.com/a?id=1');
});

test('a stateful regex flag cannot make the answer depend on parameter order', async () => {
  // uBO recognises `/…/` and `/…/i` and nothing else, so `/utm_/g` is not a regex to it at all —
  // it falls through to being a literal parameter NAME and removes nothing. Accepting the flag
  // instead made `.test()` advance `lastIndex`, so every other parameter was skipped.
  await agree('$removeparam=/utm_/g', 'https://example.com/a?utm_a=1&utm_b=2&utm_c=3&utm_d=4');
  await agree('$removeparam=/utm_/', 'https://example.com/a?utm_a=1&utm_b=2&utm_c=3&utm_d=4');
  await agree('$removeparam=/utm_/i', 'https://example.com/a?UTM_a=1&b=2');
});

test('|| anchors on the host, not on anything that merely precedes a separator', async () => {
  // Userinfo is not the host: `https://example.com@evil.example.net/` is a request to
  // `evil.example.net`, and a rule for `example.com` must not fire on it.
  await agree('||example.com$removeparam=id', 'https://example.com@evil.example.net/a?id=1');
  await agree('||example.com^$removeparam=id', 'https://example.com@evil.example.net/a?id=1');
  await agree('||example.com^$removeparam=id', 'https://example.com/a?id=1');
});

test('a domain anchor immediately followed by an end anchor is not match-all', async () => {
  // The block matcher has no content blocks for `|||`; forgetting that the trailing `|` still
  // constrains the match turned this degenerate pattern into a rule that fired on every URL.
  await agree('|||$removeparam=id', 'https://example.com/a?id=1');
});

test('the host index and a plain linear scan cannot disagree', async () => {
  // The index is an optimisation; a single-rule difference between the two paths is silent, and
  // only an equivalence check catches it.
  const rules = '||example.com^$removeparam=id\n$removeparam=/^utm_/';
  for (const target of [
    'https://example.com/a?id=1&utm_a=2&keep=3',
    'https://example.com@evil.example.net/a?id=1&utm_a=2',
    'https://sub.example.com/a?id=1',
    'https://notexample.com/a?id=1&utm_a=2',
  ]) {
    const indexed = compileFilters([{ id: 'diff', text: rules }]);
    const plain = compileFilters([{ id: 'diff', text: rules }], { noIndex: true });
    const a = decideQueryFor(target, indexed);
    const b = decideQueryFor(target, plain);
    assert.deepEqual(a?.decision.keep, b?.decision.keep, `index vs linear scan differ on ${target}`);
  }
});
