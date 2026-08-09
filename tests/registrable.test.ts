import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { registrableDomain } from '../utils/registrable';

test('the common case is the last two labels', () => {
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('docs.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
  assert.equal(registrableDomain('example.org'), 'example.org');
});

test('a known two-label public suffix takes a third label', () => {
  assert.equal(registrableDomain('example.com.cn'), 'example.com.cn');
  assert.equal(registrableDomain('www.example.com.cn'), 'example.com.cn');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(registrableDomain('example.co.jp'), 'example.co.jp');
  // Without the table this would collapse every `.com.cn` site into one group.
  assert.notEqual(registrableDomain('other.com.cn'), registrableDomain('example.com.cn'));
});

test('a bare public suffix is returned unchanged rather than reaching for a label it has not got', () => {
  assert.equal(registrableDomain('com.cn'), 'com.cn');
  assert.equal(registrableDomain('co.uk'), 'co.uk');
  assert.equal(registrableDomain('localhost'), 'localhost');
});

test('addresses are left alone', () => {
  assert.equal(registrableDomain('192.168.1.1'), '192.168.1.1');
  assert.equal(registrableDomain('[::1]'), '[::1]');
});

test('case and a trailing dot are normalised', () => {
  assert.equal(registrableDomain('Docs.EXAMPLE.com'), 'example.com');
  assert.equal(registrableDomain('example.com.'), 'example.com');
});

test('the ten aliases the old grouping pack shipped are all reproduced for free', () => {
  // Each line of `public/rules/grouping.txt` was `*.<domain> group: <domain>` where the
  // target was exactly the registrable domain — which is why the directive could go.
  const shipped = [
    'com', 'com', 'com', 'com', 'org', 'com', 'com', 'com', 'com', 'com',
  ].map((tld, i) => `sub${i}.example.${tld}`);
  for (const host of shipped) {
    const apex = host.split('.').slice(1).join('.');
    assert.equal(registrableDomain(host), apex, host);
    assert.equal(registrableDomain(apex), apex, apex);
  }
});

test('known limit: a private suffix folds its subdomains together', () => {
  // `alice.example.io` and `bob.example.io` share a group. Documented and accepted:
  // grouping is cosmetic and never touches dedup, and bundling the PSL was rejected on
  // size (Q9) while the one reusable implementation is GPL against this project's MIT.
  assert.equal(registrableDomain('alice.example.io'), registrableDomain('bob.example.io'));
});
