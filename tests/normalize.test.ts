import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { compileFilters } from '../utils/filters';
import { buildRestoreUrl, normalizeUrl, titleFromUrl } from '../utils/normalize';
import type { Item } from '../utils/types';

const compile = (text = '') => compileFilters([{ id: 'test', text }]);
const key = (url: string, text = '') => {
  const result = normalizeUrl(url, compile(text));
  assert.ok(result, `normalizeUrl returned null for ${url}`);
  return result.urlKey;
};

// ---------------------------------------------------------------- defaults

test('with no filters, query order and raw serialization are identity-bearing', () => {
  assert.equal(
    key('https://example.com/post/123?utm_source=x&id=7'),
    'https://example.com/post/123?utm_source=x&id=7',
  );
  assert.notEqual(
    key('https://example.com/x?b=2&a=1'),
    key('https://example.com/x?a=1&b=2'),
  );
  assert.notEqual(key('https://example.com/x?flag'), key('https://example.com/x?flag='));
  assert.notEqual(key('https://example.com/x?q=a+b'), key('https://example.com/x?q=a%20b'));
  assert.equal(
    key('https://example.com/x?a=1&&a=2&'),
    'https://example.com/x?a=1&&a=2&',
  );
});

test('scheme, www, trailing slash and ordinary fragments remain distinct', () => {
  assert.equal(key('https://www.example.com/a/'), 'https://www.example.com/a/');
  assert.notEqual(key('http://example.com/a'), key('https://example.com/a'));
  assert.notEqual(key('https://example.com/a/'), key('https://example.com/a'));
  assert.notEqual(key('https://www.example.com/a'), key('https://example.com/a'));
  assert.equal(key('https://example.com/post#section-2'), 'https://example.com/post#section-2');
});

test('raw query separators and encodings cannot forge another URL identity', () => {
  assert.notEqual(key('https://example.com/a?x=1%26y=2'), key('https://example.com/a?x=1&y=2'));
  assert.notEqual(key('https://example.com/a?x%3Dy=1'), key('https://example.com/a?x=y=1'));
  assert.equal(
    key('https://example.com/go?url=https%3A%2F%2Fa.example%26utm_source=x'),
    'https://example.com/go?url=https%3A%2F%2Fa.example%26utm_source=x',
  );
  assert.equal(key('https://example.com/a?x=100%25'), 'https://example.com/a?x=100%25');
});

test('the key is built from the URL standard\'s serialization, not from how it was typed', () => {
  // The query is still verbatim — order, duplicates and encoding are all preserved — but it comes
  // from `url.search`, so a spelling the URL standard itself canonicalizes lands on ONE key.
  // Reading the input string instead minted keys the save path could never produce: everything a
  // browser hands us is already serialized, while `importPayload` and the options tester are fed
  // free text, so `?q=café` imported from a JSON file became a second item for the same page.
  assert.equal(key('https://example.com/a?q=café'), key('https://example.com/a?q=caf%C3%A9'));
  assert.equal(key('https://example.com/a?q=a b'), key('https://example.com/a?q=a%20b'));
  assert.equal(key('https://example.com/a?q=café'), 'https://example.com/a?q=caf%C3%A9');
  // The one distinction this gives up. No save path can observe it — browsers drop a bare `?`.
  assert.equal(key('https://example.com/a?'), key('https://example.com/a'));
});

test('a tab or newline in the query cannot make removal target the wrong parameter', () => {
  // The segments used to come from the input string while the params came from the parsed URL,
  // zipped positionally. The URL parser deletes tab/LF/CR, so a segment made only of one existed
  // on one side and not the other, shifted the pairing by one, and the removal landed one
  // parameter over: with this exact input the rule's own target survived and the content-bearing
  // `id` was dropped instead. Both sides now read `url.search`, so the counts cannot diverge.
  const rule = '$removeparam=fbclid';
  assert.equal(key('https://example.com/a?\t&id=7&fbclid=aaa', rule), 'https://example.com/a?&id=7');
  assert.equal(key('https://example.com/a?\n&id=7&fbclid=aaa', rule), 'https://example.com/a?&id=7');
  // And two different articles must not collapse onto one key, which is what made it data loss.
  assert.notEqual(
    key('https://example.com/a?\t&id=7&fbclid=aaa', rule),
    key('https://example.com/a?\t&id=8&fbclid=aaa', rule),
  );
  // A stripped character elsewhere in the query removes nothing that was not named.
  assert.equal(key('https://example.com/a?x=1&\n&b=2', rule), 'https://example.com/a?x=1&&b=2');
});

test('safe host equivalences still fold together', () => {
  assert.equal(key('https://example.com./a'), key('https://example.com/a'));
  assert.equal(key('https://example.com../a'), 'https://example.com/a');
  assert.equal(key('https://EXAMPLE.com:443/a'), 'https://example.com/a');
  assert.equal(key('http://EXAMPLE.com:80/a'), 'http://example.com/a');
  assert.equal(key('https://example.com.:8443/a'), 'https://example.com:8443/a');
});

test('only text-fragment restore state is removed from identity', () => {
  assert.equal(
    key('https://example.com/post#:~:text=hello%20world'),
    'https://example.com/post',
  );
  assert.equal(
    key('https://example.com/post#intro:~:text=hello'),
    'https://example.com/post#intro',
  );
  assert.notEqual(key('https://example.com/post#intro'), key('https://example.com/post#summary'));
  assert.equal(key('https://example.com/post#:~:other=value'), 'https://example.com/post#:~:other=value');
});

test('PDF page fragments update position without changing identity', () => {
  assert.equal(key('https://example.com/book.PDF#page=3'), 'https://example.com/book.PDF');
  assert.equal(
    key('https://example.com/book.pdf#page=3'),
    key('https://example.com/book.pdf#page=99'),
  );
  assert.equal(
    key('https://example.com/book.pdf#page=3&zoom=125'),
    'https://example.com/book.pdf#zoom=125',
  );
  assert.equal(
    key('https://example.com/viewer#page=3'),
    'https://example.com/viewer#page=3',
    'non-.pdf paths remain ordinary URLs in v0.1',
  );
});

test('only http/https produce a key', () => {
  assert.equal(normalizeUrl('file:///C:/notes/a.html', compile()), null);
  assert.equal(normalizeUrl('ftp://example.com/a', compile()), null);
  assert.equal(normalizeUrl('chrome://extensions', compile()), null);
  assert.equal(normalizeUrl('javascript:alert(1)', compile()), null);
});

test('unparseable input yields null instead of a bogus key', () => {
  assert.equal(normalizeUrl('not a url', compile()), null);
  assert.equal(normalizeUrl('', compile()), null);
});

// ---------------------------------------------------------------- filters

test('a regex value removes matching segments without reordering survivors', () => {
  assert.equal(
    key('https://example.com/a?z=9&utm_source=x&id=7&utm_id=2', '$removeparam=/^utm_/'),
    'https://example.com/a?z=9&id=7',
  );
});

test('removal preserves duplicate, valueless, encoded and empty surviving segments', () => {
  assert.equal(
    key(
      'https://example.com/a?flag&&utm_source=x&q=a+b&q=a%20b&&tail=',
      '$removeparam=/^utm_/',
    ),
    'https://example.com/a?flag&&q=a+b&q=a%20b&&tail=',
  );
});

test('an inverted value keeps only what it names', () => {
  assert.equal(
    key('https://example.com/a?id=7&x=1&utm_a=2', '||example.com^$removeparam=~/^id=/'),
    'https://example.com/a?id=7',
  );
});

test('a bare $removeparam clears the query for that host only', () => {
  const text = '||noisy.example^$removeparam';
  assert.equal(key('https://noisy.example/a?x=1&y=2', text), 'https://noisy.example/a');
  assert.equal(key('https://other.example/a?x=1', text), 'https://other.example/a?x=1');
});

test('filters see www and the identity preserves it', () => {
  assert.equal(
    key('https://www.example.com/a?x=1', '||example.com^$removeparam=x'),
    'https://www.example.com/a',
  );
});

test('filters still match a canonicalized trailing FQDN host', () => {
  const rule = '||example.com^$removeparam=x';
  assert.equal(
    key('https://example.com./a?x=1&y=2', rule),
    'https://example.com/a?y=2',
  );
});

// ---------------------------------------------------------------- restore url

function itemWith(url: string, progress: Item['progress']): Item {
  return { urlKey: 'k', url, title: 't', addedAt: 0, updatedAt: 0, status: 'unread', progress };
}

test('buildRestoreUrl percent-encodes the dash separator and keeps an existing hash', () => {
  const url = buildRestoreUrl(
    itemWith('https://example.com/a#intro', {
      scrollY: 100,
      docHeight: 1000,
      percent: 0.3,
      textStart: 'well-known thing',
      textEnd: 'the end',
    }),
  );
  assert.ok(url.startsWith('https://example.com/a#intro:~:text='), url);
  assert.ok(url.includes('%2D'), 'a literal dash would be parsed as a text-fragment separator');
  assert.ok(url.includes(','), 'textStart,textEnd pair expected');
});

test('buildRestoreUrl builds a bare fragment when the url has no hash', () => {
  const url = buildRestoreUrl(
    itemWith('https://example.com/a', { scrollY: 0, docHeight: 10, percent: 0, textStart: 'hello' }),
  );
  assert.equal(url, 'https://example.com/a#:~:text=hello');
});

test('buildRestoreUrl leaves PDF page state untouched', () => {
  const item = itemWith('https://example.com/book.pdf#page=7', {
    scrollY: 100,
    docHeight: 1000,
    percent: 0.3,
    textStart: 'ignored anchor',
  });
  assert.equal(buildRestoreUrl(item), item.url);
});

test('buildRestoreUrl passes the url through untouched without progress', () => {
  assert.equal(buildRestoreUrl(itemWith('https://example.com/a', null)), 'https://example.com/a');
});

test('titleFromUrl produces something readable as the last fallback', () => {
  assert.equal(titleFromUrl('https://example.com/posts/my-first-post.html'), 'my first post');
  assert.equal(titleFromUrl('https://example.com/'), 'example.com');
  assert.equal(titleFromUrl('https://www.example.com'), 'example.com');
});
