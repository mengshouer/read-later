import type { Item } from './types';
import type { CompiledFilters, QueryDecision, QueryParam } from './filters';
// Explicit extension so plain Node can load this module graph: `scripts/filter-probe.mjs`
// imports `decideQueryFor` from here to compare against uBO, and Node does not resolve
// extensionless specifiers. `allowImportingTsExtensions` is on, and the bundler is indifferent.
import { decideQuery, queryParamsOf } from './filters.ts';

export interface NormalizedUrl {
  /** Storage primary key suffix. It is a canonical HTTP(S) identity string. */
  urlKey: string;
}

/**
 * The hostname used for *display and grouping*, which is deliberately not the one inside a
 * `urlKey`: a cosmetic `www.` does not deserve its own section in the list, while URL identity
 * keeps it so two distinct endpoints never merge. Those two rules disagree, so there is one
 * function for each and `NormalizedUrl` carries no hostname at all — a field that looked
 * interchangeable with this was only ever a way to group by the wrong one.
 */
export function hostnameOf(rawUrl: string): string | null {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
    return h || null;
  } catch {
    return null;
  }
}

function isPdfPath(url: URL): boolean {
  return /\.pdf$/i.test(url.pathname);
}

function identityHash(url: URL): string {
  let hash = url.hash;

  // We generate this directive when opening a saved page. It is restore state, not page
  // identity. Ordinary anchors and every other fragment remain identity-bearing.
  const textDirective = hash.indexOf(':~:text=');
  if (textDirective >= 0) hash = hash.slice(0, textDirective);
  if (hash === '#') hash = '';

  // Browser PDF viewers encode the current page in the URL. Keep it in Item.url so the
  // latest save reopens at that page, but do not create one record per page of the same PDF.
  if (hash && isPdfPath(url)) {
    const segments = hash.slice(1).split('&');
    const kept = segments.filter((segment) => !/^page=\d+$/i.test(segment));
    if (kept.length !== segments.length) hash = kept.length ? `#${kept.join('&')}` : '';
  }

  return hash;
}

/**
 * Folds the URL-standard host equivalences and rejects anything not http(s).
 *
 * Separate and exported because more than one caller needs the *same* canonical URL: doing the
 * folding twice, slightly differently, is what let the options-page tester report on a different
 * host than the key printed beside it.
 */
export function canonicalHttpUrl(rawUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  // A fully-qualified trailing dot is a standards-level host spelling equivalence. Apply it to
  // the URL object, so host-based filter matching and the key see the same canonical host.
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.replace(/\.+$/, '');
  if (!url.hostname) return null;

  return url;
}

export interface QueryVerdict {
  /** The canonical URL the decision was made against. */
  url: URL;
  params: QueryParam[];
  decision: QueryDecision;
}

/**
 * The one place a URL is canonicalized and asked which query segments survive. `normalizeUrl`
 * builds the storage key from this; the options-page tester reports from it. They used to do
 * their own preprocessing side by side, so the tester could contradict the key shown next to it.
 *
 * `queryParamsOf` reads `url.search`, deliberately, and not the query as it was spelled in the
 * input. The query is still kept VERBATIM — order, duplicates and encoding are all preserved, so
 * the identity rule below is unchanged. What `url.search` adds is the URL standard's own
 * canonicalization: a literal space becomes `%20`, non-ASCII becomes percent-encoded, a tab or
 * newline is dropped. Reading the input string instead broke two things.
 *
 * One, it made the segment list and the parsed params disagree about how many segments there
 * are, and they are zipped positionally — so a segment consisting only of a tab or newline
 * (which the parser deletes) shifted the pairing by one and the removal landed on the WRONG
 * parameter. Measured, with `$removeparam=fbclid` active: `?\t&id=7&fbclid=aaa` kept `fbclid`
 * and dropped `id=7`, and `?\t&id=7…` / `?\t&id=8…` collapsed onto one key, merging two
 * different articles into one.
 *
 * Two, it minted keys the save path can never produce. Everything the browser hands us is
 * already serialized, but `importPayload` takes a URL out of a JSON file and this tester takes
 * whatever was pasted, so `?q=café` imported that way became a different item from the
 * `?q=caf%C3%A9` a real save stores.
 *
 * The one distinction lost is a bare `?` with nothing after it, which `url.search` reports as
 * empty. No save path can observe it: browsers drop it from the address bar.
 */
export function decideQueryFor(rawUrl: string, filters: CompiledFilters): QueryVerdict | null {
  const url = canonicalHttpUrl(rawUrl);
  if (!url) return null;
  const params = queryParamsOf(url);
  const decision = decideQuery(filters, url.href, url.hostname.toLowerCase(), params);
  return { url, params, decision };
}

/**
 * Conservative identity normalization. Only safe URL-standard equivalences are folded:
 * scheme/host case, default ports and a trailing FQDN dot. Potentially meaningful spelling
 * is retained: http and https, `www.`, path trailing slashes, query serialization and ordinary
 * fragments are all distinct unless an explicit `$removeparam` rule removes a query segment.
 */
export function normalizeUrl(rawUrl: string, filters: CompiledFilters): NormalizedUrl | null {
  const verdict = decideQueryFor(rawUrl, filters);
  if (!verdict) return null;
  const { url, params, decision } = verdict;

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const hostname = url.hostname.toLowerCase();
  const port = url.port ? `:${url.port}` : '';
  const path = url.pathname.replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());

  const search = url.search;
  let query = search;

  if (decision.keep.some((keep) => !keep)) {
    const removedSegments = new Set(
      params.filter((_, index) => !decision.keep[index]).map((param) => param.segmentIndex),
    );
    const body = search.startsWith('?') ? search.slice(1) : search;
    const keptSegments = body
      .split('&')
      .filter((_, segmentIndex) => !removedSegments.has(segmentIndex));
    query = keptSegments.length ? `?${keptSegments.join('&')}` : '';
  }

  return {
    urlKey: `${scheme}://${hostname}${port}${path}${query}${identityHash(url)}`,
  };
}

/** Only http/https pages are savable — everything else cannot be injected into anyway. */
export function isSavableUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  return /^https?:\/\//i.test(rawUrl);
}

/** Last resort title: readable-ish slug from the URL. */
export function titleFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      const decoded = decodeURIComponent(last).replace(/\.(html?|php|aspx?|jsp|md)$/i, '');
      const pretty = decoded.replace(/[-_+]+/g, ' ').trim();
      if (pretty) return pretty;
    }
    return url.hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

/**
 * Attach a scroll-to-text-fragment directive. This is best-effort: a miss simply opens the
 * page normally, and no host permission or injected fallback is used during restore.
 */
export function buildRestoreUrl(item: Item): string {
  const progress = item.progress;
  if (!progress || !progress.textStart) return item.url;

  try {
    if (isPdfPath(new URL(item.url))) return item.url;
  } catch {
    return item.url;
  }

  // `-` is a text-fragment separator and encodeURIComponent leaves it alone.
  const enc = (value: string) => encodeURIComponent(value).replace(/-/g, '%2D');
  const body = progress.textEnd
    ? `text=${enc(progress.textStart)},${enc(progress.textEnd)}`
    : `text=${enc(progress.textStart)}`;

  const hashIndex = item.url.indexOf('#');
  const base = hashIndex >= 0 ? item.url.slice(0, hashIndex) : item.url;
  const rawHash = hashIndex >= 0 ? item.url.slice(hashIndex) : '';
  const cleanHash = (rawHash.split(':~:text=')[0] ?? '').replace(/^#$/, '');
  return `${base}#${cleanHash.replace(/^#/, '')}:~:${body}`;
}
