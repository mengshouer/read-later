/**
 * The group key: a hostname reduced to its registrable domain, so `docs.example.com`
 * and `example.com` land in one group without anybody configuring an alias.
 *
 * This replaces the old `group:` directive. Every one of the ten aliases the bundled
 * grouping pack shipped was exactly "fold subdomains into the registrable domain", so
 * the whole feature was a hand-maintained restatement of a rule a function can compute.
 *
 * WHY NOT THE PUBLIC SUFFIX LIST: bundling it was measured at 103–157 KB minified and
 * rejected (Q9), and the one implementation worth reusing (`publicsuffixlist` inside
 * `@gorhill/ubo-core`) is GPL while this project is MIT. So the last two labels are
 * taken, plus a third when the last two are a known multi-part suffix.
 *
 * KNOWN LIMIT, accepted deliberately: private suffixes are not in that table, so
 * `alice.github.io` and `bob.github.io` group together as `github.io`, and likewise for
 * `*.vercel.app` or `*.blogspot.com`. Grouping is cosmetic and never touches dedup, and
 * the old grouping pack folded `*.medium.com` and `*.substack.com` on purpose — the same
 * direction. If it does start to grate, the fix is a short list of private suffixes
 * checked before this table, not a 150 KB dependency.
 */

/**
 * Public suffixes made of two labels. Deliberately partial: it covers the ccTLD spaces
 * this extension's two UI languages actually browse, and a miss costs one wrongly
 * merged group heading, never a wrong dedup key.
 */
const MULTI_PART_SUFFIXES = new Set([
  'ac.cn', 'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn',
  'com.hk', 'edu.hk', 'org.hk', 'net.hk',
  'com.tw', 'edu.tw', 'gov.tw', 'org.tw',
  'ac.jp', 'co.jp', 'ne.jp', 'or.jp', 'go.jp',
  'ac.uk', 'co.uk', 'gov.uk', 'org.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.kr', 'or.kr', 'ne.kr',
  'co.in', 'co.id', 'co.il', 'co.nz', 'co.th', 'co.za',
  'com.ar', 'com.br', 'com.mx', 'com.my', 'com.ph', 'com.pl',
  'com.sg', 'com.tr', 'com.ua', 'com.vn',
]);

/** Bare IPv4 — grouping an address by "last two labels" would be nonsense. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return host;
  // IPv6 arrives bracketed from `URL.hostname`; either form has no registrable domain.
  if (host.includes(':') || IPV4.test(host)) return host;

  const labels = host.split('.');
  if (labels.length <= 2) return host;

  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return labels.length <= 3 ? host : labels.slice(-3).join('.');
  }
  return lastTwo;
}
