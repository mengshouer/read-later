/**
 * Filter rules — a STRICT SUBSET of uBlock Origin / AdGuard static filter syntax,
 * covering `$removeparam` and the options that decide whether a `$removeparam` applies.
 *
 *   $removeparam=fbclid                      remove `fbclid` everywhere
 *   ||example.com^$removeparam=/^utm_/       remove params matching a regex, on one site
 *   ||example.com^$removeparam               clear the whole query on one site
 *   ||example.com^$removeparam=~/^(v|t)=/    keep ONLY `v` and `t` there
 *   @@||example.com^$removeparam             never touch that site's query
 *
 * WHY AN EXISTING SYNTAX: rules are the one thing the user has to author, and a
 * homegrown format means a format with no documentation, no existing lists and no
 * transferable knowledge. This one is what AdGuard's "URL Tracking Protection" and
 * uBO's tracking-param lists are written in, so a real 3,788-line list can be
 * subscribed to verbatim, and `$removeparam=fbclid` can be googled.
 *
 * TWO CONSTRAINTS THAT KEEP THAT PROMISE TRUE — break either and a rule written here
 * stops working when pasted into uBO, which was the entire point:
 *
 *   1. NO CONVENIENCE SUGAR. No `utm_*` globs, no `$removeparam=a,b,c` lists, no
 *      `keep:`. Every ergonomic shortcut would be a rule that runs here and dies
 *      there. `keep: v,t` costs `~/^(v|t)=/` and that is the honest price.
 *   2. A REGEX VALUE MATCHES `name=value`, not the name alone — uBO's documented
 *      behaviour ("tested against each query parameter name-value pair assembled
 *      into a single string as `name=value`"). Matching the name only would silently
 *      diverge on every regex rule.
 *
 * WHAT WE ARE, AS A REQUEST: a saved URL is always evaluated as a FIRST-PARTY,
 * TOP-LEVEL DOCUMENT. That single premise decides every request-type option for us:
 * `$document` applies, `$xhr` / `$script` / `$image` / `$3p` cannot. Ignoring those
 * options instead would silently over-apply ~56 rules of the AdGuard list.
 *
 * Nothing is built in. A parsed set is only ever what the user typed plus the lists
 * they subscribed to, and `scripts/filter-probe.mjs` diffs this implementation
 * against uBO's real engine to keep the subset claim honest.
 */

/** Why a line was parsed but will not participate. */
export type SkipBucket =
  /** Correct behaviour: the line cannot apply to a stored page URL by design. */
  | 'not-applicable'
  /** Our gap: the line affects the outcome in uBO and we cannot honour it. */
  | 'unsupported'
  /** Malformed — only ever interesting for the user's own text. */
  | 'invalid';

export interface SkippedLine {
  source: string;
  line: number;
  raw: string;
  bucket: SkipBucket;
  reason: string;
}

/** One text blob to compile. `id` travels into every hit so the tester can name it. */
export interface FilterSource {
  id: string;
  text: string;
}

type ValueMatcher =
  | { kind: 'all' }
  | { kind: 'name'; name: string }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'not-name'; name: string }
  | { kind: 'not-regex'; re: RegExp };

export interface Filter {
  source: string;
  line: number;
  raw: string;
  /** The pattern half, kept so the index can be bypassed for the equivalence test. */
  pattern: string;
  /** `@@` — spares params instead of removing them. */
  exception: boolean;
  value: ValueMatcher;
  /**
   * The `$removeparam` argument exactly as written, `''` for a bare `$removeparam`.
   *
   * uBO cancels a block directive against an exception by comparing THESE strings, not by
   * re-matching parameters: `toAdd`/`toRemove` are keyed on `result.value` and cancelled by exact
   * equality. So `@@…$removeparam=utm_source` does not carve `utm_source` out of a
   * `$removeparam=/^utm_/` removal — it only cancels another `$removeparam=utm_source`.
   */
  valueText: string;
  /**
   * Set when the pattern is exactly `||host^`, which the host index decides on its
   * own: after a hostname a URL always continues with `/`, `?`, `#` or `:`, all of
   * which satisfy `^`. 67% of the AdGuard list is this shape, and skipping a regex
   * for it is what keeps a 2,000-item rekey at tens of milliseconds.
   */
  host: string | null;
  /** Run against the whole URL when the host alone cannot decide. */
  urlTest: RegExp | null;
  includeDomains: string[];
  excludeDomains: string[];
  denyallow: string[];
}

interface Index {
  /** Pattern is empty or `*`: applicable to every URL. */
  always: Filter[];
  /** Keyed by the host of `||host…`; lookup walks up the label chain. */
  byHost: Map<string, Filter[]>;
  /** Needs `urlTest` against the full URL. */
  generic: Filter[];
}

export interface CompiledFilters {
  block: Index;
  allow: Index;
  /** How many lines will actually participate. */
  active: number;
  /** Everything that will not, with the reason and which bucket it falls in. */
  skipped: SkippedLine[];
}

function emptyIndex(): Index {
  return { always: [], byHost: new Map(), generic: [] };
}

// ---------------------------------------------------------------- host helpers

/**
 * `example.com` matches itself and any subdomain; `example.*` is the entity form and
 * matches any TLD. Used for both `$domain=` and `$denyallow=`.
 */
export function hostMatches(pattern: string, hostname: string): boolean {
  if (pattern.endsWith('.*')) {
    const stem = pattern.slice(0, -1); // keep the dot: `example.`
    return hostname.startsWith(stem) || hostname.includes('.' + stem);
  }
  return hostname === pattern || hostname.endsWith('.' + pattern);
}

/** `a.b.example.com` → itself, `b.example.com`, `example.com`, `com`. */
function hostSuffixes(hostname: string): string[] {
  const out: string[] = [hostname];
  let rest = hostname;
  for (;;) {
    const dot = rest.indexOf('.');
    if (dot < 0) break;
    rest = rest.slice(dot + 1);
    if (!rest) break;
    out.push(rest);
  }
  return out;
}

// ---------------------------------------------------------------- pattern → regex

const RE_META = /[.*+?^${}()|[\]\\]/g;

/**
 * uBO pattern syntax: a pattern wrapped in `/…/` is a regular expression; otherwise `||`
 * anchors at a domain-label boundary, `|` anchors the URL start or end, `^` is a separator
 * character, `*` is any sequence, and anything else is a literal substring match.
 *
 * Case-insensitive, because uBO lowercases both the pattern and the URL before matching unless
 * `$match-case` is given — and `$match-case` is reported as unsupported, so such a rule never
 * reaches here. Compiling case-sensitively meant `||example.com/track/` missed `/TRACK/`.
 */
function patternToRegex(pattern: string): RegExp | null {
  // A `/…/` pattern is a regex in uBO, not a literal. Escaping it produced a rule that counted
  // as active and could never match — the worst of both, since the options page said it was fine.
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      return new RegExp(pattern.slice(1, -1), 'i');
    } catch {
      return null;
    }
  }

  let src = '';
  let i = 0;
  if (pattern.startsWith('||')) {
    // `[^/?#]*\.` would also swallow `user@` in `https://example.com@evil.example.net/`, so a
    // rule for one host fired on a request to a completely different one. Userinfo ends at the
    // last `@` before the path, so the optional part before the host must exclude `@` as well.
    // `(?:[^/?#]*@)?` alone is not enough: the engine happily backtracks to a zero-length
    // userinfo and then matches the pattern INSIDE the credentials, so `||example.com` fired on
    // `https://example.com@evil.example.net/` — a request to a completely different host. The
    // lookahead forbids that by asserting no further `@` remains before the path.
    src += '^[a-z][a-z0-9+.-]*://(?:[^/?#]*@)?(?![^/?#]*@)(?:[^/?#@]*\\.)?';
    i = 2;
  } else if (pattern.startsWith('|')) {
    src += '^';
    i = 1;
  }
  let end = pattern.length;
  let anchorEnd = false;
  if (end > i && pattern.endsWith('|')) {
    end--;
    anchorEnd = true;
  }
  for (; i < end; i++) {
    const c = pattern[i] as string;
    if (c === '*') src += '.*';
    // A separator is anything outside the set of characters allowed in a hostname
    // or path segment, or the end of the URL.
    else if (c === '^') src += '(?:[^a-zA-Z0-9_\\-.%]|$)';
    else src += c.replace(RE_META, '\\$&');
  }
  if (anchorEnd) src += '$';
  try {
    return new RegExp(src, 'i');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- option parsing

/** Splits on commas that are not inside a `/…/` regex literal. */
function splitOptions(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let inRegex = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === '/' && raw[i - 1] !== '\\') inRegex = !inRegex;
    if (c === ',' && !inRegex) {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out.filter((s) => s !== '');
}

/**
 * uBO's own value grammar, transcribed from `parseQueryPruneValue`:
 *
 *   ''            → applies to every parameter
 *   ~…            → negated
 *   /…/  /…/i     → a regex. ONLY the `i` flag is recognised.
 *   |foo          → legacy anchored regex, `^foo` case-insensitive
 *   a|b           → multiple values, which uBO refuses outright
 *   anything else → a literal parameter NAME
 *
 * The flag rule is the load-bearing part. `/utm_/g` does not match `/^\/(.+)\/(i)?$/`, so uBO
 * falls all the way through and looks for a parameter literally named `/utm_/g` — it removes
 * nothing. Accepting arbitrary flags instead made `.test()` stateful, and which parameters
 * survived then depended on how many there were: measured, `/utm_/g` over four `utm_*` params
 * removed the first and third.
 */
function parseValue(raw: string | null): ValueMatcher | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { kind: 'all' };

  const negated = trimmed.charCodeAt(0) === 0x7e; /* ~ */
  const body = negated ? trimmed.slice(1) : trimmed;
  if (body === '') return null;

  const asRegex = /^\/(.+)\/(i)?$/.exec(body);
  if (asRegex) {
    try {
      const re = new RegExp(asRegex[1] as string, asRegex[2] ?? '');
      return negated ? { kind: 'not-regex', re } : { kind: 'regex', re };
    } catch {
      return null;
    }
  }

  if (body.startsWith('|')) {
    try {
      const re = new RegExp(`^${body.slice(1)}`, 'i');
      return negated ? { kind: 'not-regex', re } : { kind: 'regex', re };
    } catch {
      return null;
    }
  }

  // uBO: "Multiple values not supported (because very inefficient)" — the directive is discarded.
  if (body.includes('|')) return null;

  return negated ? { kind: 'not-name', name: body } : { kind: 'name', name: body };
}

/**
 * Request types. We are a top-level document, so `document` is the only one that can
 * describe us — a rule scoped to any other type is correctly inert here rather than
 * being applied anyway.
 */
const TYPE_OPTIONS = new Set([
  'document', 'doc', 'subdocument', 'frame', 'script', 'image', 'stylesheet', 'css',
  'xmlhttprequest', 'xhr', 'media', 'font', 'websocket', 'other', 'ping', 'beacon',
  'object', 'object-subrequest', 'csp_report', 'webrtc', 'inline-script', 'inline-font',
  // Types, not free options: a saved page is never a popup, so a popup-scoped rule is inert here.
  // Treating them as ignorable applied those rules to the document instead.
  'popup', 'popunder',
]);
const DOCUMENT_TYPES = new Set(['document', 'doc', 'all']);

/** Options that change nothing for us and can be accepted silently. */
const IGNORABLE = new Set(['_']);

type LineResult =
  | { ok: true; filter: Filter }
  | { ok: false; bucket: SkipBucket; reason: string };

export function parseFilterLine(raw: string, line: number, source: string): LineResult | null {
  const body = raw.trim();
  // Filter lists comment with `!`, and `[Adblock Plus 2.0]` headers appear at the top.
  // `#` is NOT a comment here — it starts a cosmetic filter — so the old DSL's `#`
  // comments deliberately do not carry over.
  if (body === '' || body.startsWith('!') || body.startsWith('[')) return null;

  if (/^[^\s]*#[@?$%]?#/.test(body)) {
    return { ok: false, bucket: 'not-applicable', reason: 'cosmetic filter' };
  }

  const exception = body.startsWith('@@');
  const rest = exception ? body.slice(2) : body;

  // Options start after the pattern. A regex pattern can itself contain `$`, so find
  // its closing delimiter first — the FIRST unescaped `/` after the opener, not the last one in
  // the line. Taking the last one swallowed a regex `$removeparam` value too, so
  // `/example\.com\/\d/$removeparam=/^utm_/` found no `$` after it and was dropped as a plain
  // blocking rule, with "no $removeparam" as the reported reason.
  let dollar: number;
  if (rest.startsWith('/')) {
    let close = -1;
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '/' && rest[i - 1] !== '\\') {
        close = i;
        break;
      }
    }
    dollar = close > 0 ? rest.indexOf('$', close) : rest.indexOf('$');
  } else {
    dollar = rest.indexOf('$');
  }
  if (dollar < 0) {
    return { ok: false, bucket: 'not-applicable', reason: 'blocking rule, no $removeparam' };
  }

  const pattern = rest.slice(0, dollar);
  const options = splitOptions(rest.slice(dollar + 1));

  let value: ValueMatcher | null = null;
  let valueText = '';
  let seenRemoveparam = false;
  const includeDomains: string[] = [];
  const excludeDomains: string[] = [];
  const denyallow: string[] = [];
  let seenDomainOption = false;
  let typesSeen = false;
  let documentAllowed = false;

  for (const option of options) {
    const negated = option.startsWith('~');
    const bare = negated ? option.slice(1) : option;
    const eq = bare.indexOf('=');
    const name = (eq < 0 ? bare : bare.slice(0, eq)).toLowerCase();
    const argument = eq < 0 ? null : bare.slice(eq + 1);

    if (name === 'removeparam' || name === 'queryprune') {
      if (negated) return { ok: false, bucket: 'unsupported', reason: '~removeparam' };
      seenRemoveparam = true;
      valueText = (argument ?? '').trim();
      value = parseValue(argument);
      if (value === null) {
        return { ok: false, bucket: 'invalid', reason: 'malformed $removeparam value' };
      }
      continue;
    }

    if (name === 'domain' || name === 'from') {
      if (argument === null) return { ok: false, bucket: 'invalid', reason: '$domain needs a value' };
      seenDomainOption = true;
      for (const entry of argument.split('|')) {
        const trimmed = entry.trim().toLowerCase().replace(/^\*\./, '');
        if (!trimmed) continue;
        if (trimmed.startsWith('~')) excludeDomains.push(trimmed.slice(1));
        else includeDomains.push(trimmed);
      }
      continue;
    }

    if (name === 'denyallow') {
      if (argument === null) return { ok: false, bucket: 'invalid', reason: '$denyallow needs a value' };
      for (const entry of argument.split('|')) {
        const trimmed = entry.trim().toLowerCase();
        if (trimmed) denyallow.push(trimmed);
      }
      continue;
    }

    if (TYPE_OPTIONS.has(name)) {
      // `~document` rules out the only type we are; a positive type list must contain
      // `document` for the rule to reach us.
      if (negated) {
        if (DOCUMENT_TYPES.has(name)) {
          return { ok: false, bucket: 'not-applicable', reason: `~${name}` };
        }
        continue;
      }
      typesSeen = true;
      if (DOCUMENT_TYPES.has(name)) documentAllowed = true;
      continue;
    }

    if (name === 'third-party' || name === '3p') {
      // A saved page is its own document, so it is never third-party.
      if (!negated) return { ok: false, bucket: 'not-applicable', reason: '$third-party' };
      continue;
    }
    if (name === 'first-party' || name === '1p') {
      if (negated) return { ok: false, bucket: 'not-applicable', reason: '~$first-party' };
      continue;
    }

    if (name === 'method') {
      // Restoring a saved URL is a GET. Each VALUE carries its own `~`, which the option-level
      // `negated` flag does not see: `$method=~post` excludes POST and therefore allows GET,
      // while reading it as a positive list of one made it look like "only ~post is allowed" and
      // the rule was wrongly reported as not applicable.
      const values = (argument ?? '')
        .toLowerCase()
        .split('|')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const excluded = values.filter((entry) => entry.startsWith('~')).map((entry) => entry.slice(1));
      const included = values.filter((entry) => !entry.startsWith('~'));
      const allowsGet = included.length > 0 ? included.includes('get') : !excluded.includes('get');
      if (values.length > 0 && (negated ? allowsGet : !allowsGet)) {
        return { ok: false, bucket: 'not-applicable', reason: `$method=${argument ?? ''}` };
      }
      continue;
    }

    if (name === 'app') {
      // Platform scoping: we are a browser extension, not the named application.
      return { ok: false, bucket: 'not-applicable', reason: `$app=${argument ?? ''}` };
    }

    if (IGNORABLE.has(name)) continue;

    // Everything left changes the outcome in uBO and we cannot reproduce it. Reporting
    // it is the whole point: a silent drop here is indistinguishable from a rule that
    // simply did not match, which is exactly how a config problem disguises a bug.
    return { ok: false, bucket: 'unsupported', reason: `$${name}` };
  }

  if (!seenRemoveparam || value === null) {
    return { ok: false, bucket: 'not-applicable', reason: 'no $removeparam' };
  }
  /*
   * uBO discards the entire filter when `$denyallow` appears without `$domain`:
   *
   *   case NODE_TYPE_NET_OPTION_NAME_DENYALLOW:
   *       realBad = isNegated || hasValue === false ||
   *           this.getBranchFromType(NODE_TYPE_NET_OPTION_NAME_FROM) === 0;
   *
   * (`static-filtering-parser.js`, identical in the current master and in the
   * `@gorhill/ubo-core` build the probe compares against; verified empirically too —
   * with `$domain` the rule applies, without it nothing happens.)
   *
   * This is not a detail: AdGuard's uBO-flavoured URL-tracking list ships 21 rules in
   * exactly that shape, `$removeparam=utm_source` among them. Honouring them would strip
   * more than uBO does from the very same list, which is the one thing this subset must
   * never do — so they are reported as invalid, and the shipped supplement carries the
   * important params itself.
   */
  if (denyallow.length > 0 && !seenDomainOption) {
    return { ok: false, bucket: 'invalid', reason: '$denyallow without $domain' };
  }
  if (typesSeen && !documentAllowed) {
    return { ok: false, bucket: 'not-applicable', reason: 'request type is never a document' };
  }

  // `||host^` and `||host` differ: without the separator the pattern keeps matching
  // into the label, so `||example.com` also matches `example.computer`. Only the
  // former can be settled by the host index alone.
  let host: string | null = null;
  let urlTest: RegExp | null = null;
  const hostOnly = /^\|\|([a-z0-9.\-_]+)\^$/i.exec(pattern);
  if (hostOnly) {
    host = (hostOnly[1] as string).toLowerCase();
  } else if (pattern !== '' && pattern !== '*') {
    urlTest = patternToRegex(pattern);
    if (urlTest === null) return { ok: false, bucket: 'invalid', reason: 'malformed pattern' };
    // Still worth indexing when the pattern starts at a concrete host: the regex then
    // only has to run for URLs already on that host.
    const anchored = /^\|\|([a-z0-9.\-_]+)[/^?]/i.exec(pattern);
    if (anchored) host = (anchored[1] as string).toLowerCase();
  }

  return {
    ok: true,
    filter: {
      source,
      line,
      raw: body,
      pattern,
      exception,
      value,
      valueText,
      host,
      urlTest,
      includeDomains,
      excludeDomains,
      denyallow,
    },
  };
}

// ---------------------------------------------------------------- compile

/**
 * Pure: no storage, no network. `getMatcher()` in `utils/matcher.ts` owns the cached,
 * storage-reading variant — this one is what the tests and the options page's live
 * tester call, the latter because it has to compile the draft you are still typing.
 *
 * `noIndex` forces every filter through the regex path instead of the host index. It
 * exists so a test can assert both paths agree: an index bug removes rules silently,
 * which is the failure mode no amount of per-rule unit testing would catch.
 */
export function compileFilters(
  sources: FilterSource[],
  options: { noIndex?: boolean } = {},
): CompiledFilters {
  const out: CompiledFilters = { block: emptyIndex(), allow: emptyIndex(), active: 0, skipped: [] };

  for (const source of sources) {
    const lines = source.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] as string;
      const result = parseFilterLine(raw, i + 1, source.id);
      if (result === null) continue;
      if (!result.ok) {
        out.skipped.push({
          source: source.id,
          line: i + 1,
          raw: raw.trim(),
          bucket: result.bucket,
          reason: result.reason,
        });
        continue;
      }
      const filter = result.filter;
      if (options.noIndex && filter.host !== null) {
        // The pattern regex subsumes the host check, so dropping the index key leaves
        // an equivalent filter — which is exactly what makes the two paths comparable.
        filter.urlTest = filter.urlTest ?? patternToRegex(filter.pattern);
        filter.host = null;
      }
      const index = filter.exception ? out.allow : out.block;
      if (filter.host !== null) {
        const bucket = index.byHost.get(filter.host);
        if (bucket) bucket.push(filter);
        else index.byHost.set(filter.host, [filter]);
      } else if (filter.urlTest !== null) {
        index.generic.push(filter);
      } else {
        index.always.push(filter);
      }
      out.active++;
    }
  }

  return out;
}

/** Bucket totals for the options page's three-way report. */
export function countSkipped(compiled: CompiledFilters): Record<SkipBucket, number> {
  const counts: Record<SkipBucket, number> = { 'not-applicable': 0, unsupported: 0, invalid: 0 };
  for (const entry of compiled.skipped) counts[entry.bucket]++;
  return counts;
}

/**
 * A filter line has no length limit, and real lists exercise that: AdGuard's
 * `$removeparam=utm_campaign` rule carries a `$denyallow` list of ~200 google ccTLDs on
 * one line. Printing raw lines verbatim turned the options page into a wall of text.
 */
const SAMPLE_MAX = 120;

export interface SkippedGroup {
  bucket: SkipBucket;
  reason: string;
  count: number;
  /**
   * The `$removeparam` values of the affected lines. This is what a reader actually needs
   * — "which params does this cost me" — rather than the domain lists that made the lines
   * long in the first place.
   */
  params: string[];
  /** Line numbers, ascending. */
  lines: number[];
  /** One representative line, truncated. */
  sample: string;
}

/**
 * Groups skipped lines by reason. 21 lines sharing one cause are one finding, not 21
 * problems — and none of them is anything the reader typed or can fix.
 */
export function groupSkipped(compiled: CompiledFilters): SkippedGroup[] {
  const groups = new Map<string, SkippedGroup>();
  for (const entry of compiled.skipped) {
    const key = `${entry.bucket}|${entry.reason}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        bucket: entry.bucket,
        reason: entry.reason,
        count: 0,
        params: [],
        lines: [],
        sample:
          entry.raw.length > SAMPLE_MAX ? `${entry.raw.slice(0, SAMPLE_MAX)}…` : entry.raw,
      };
      groups.set(key, group);
    }
    group.count++;
    group.lines.push(entry.line);
    // `[^,]*` stopped at the first comma, which is inside the value for a regex like
    // `$removeparam=/^(a,b)$/` — the reader was shown `/^(a` as the affected parameter.
    // `splitOptions` already knows a comma inside `/…/` is not a separator, so reuse it.
    const removeparam = splitOptions(entry.raw.slice(entry.raw.indexOf('$') + 1)).find((option) =>
      /^(removeparam|queryprune)=/.test(option),
    );
    const param = removeparam ? removeparam.slice(removeparam.indexOf('=') + 1) : '';
    if (param !== '' && !group.params.includes(param)) group.params.push(param);
  }
  return [...groups.values()];
}

/** `[484,485,486,490]` → `484–486, 490`. */
export function formatLineRanges(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index] as number;
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index++;
      end = sorted[index] as number;
    }
    parts.push(start === end ? String(start) : `${start}–${end}`);
    index++;
  }
  return parts.join(', ');
}

// ---------------------------------------------------------------- matching

function applies(filter: Filter, url: string, hostname: string): boolean {
  if (filter.urlTest !== null && !filter.urlTest.test(url)) return false;
  if (filter.includeDomains.length > 0 && !filter.includeDomains.some((d) => hostMatches(d, hostname))) {
    return false;
  }
  if (filter.excludeDomains.some((d) => hostMatches(d, hostname))) return false;
  if (filter.denyallow.some((d) => hostMatches(d, hostname))) return false;
  return true;
}

/**
 * Every filter in `index` that applies to this URL. The host index is a prefilter
 * only — `applies` still runs, because an indexed filter can carry `$domain=`.
 */
function collect(index: Index, url: string, hostname: string): Filter[] {
  const found: Filter[] = [];
  for (const filter of index.always) {
    if (applies(filter, url, hostname)) found.push(filter);
  }
  for (const suffix of hostSuffixes(hostname)) {
    const bucket = index.byHost.get(suffix);
    if (!bucket) continue;
    for (const filter of bucket) {
      if (applies(filter, url, hostname)) found.push(filter);
    }
  }
  for (const filter of index.generic) {
    if (applies(filter, url, hostname)) found.push(filter);
  }
  return found;
}

/**
 * uBO's own comparison, param by param: a name is compared against the RAW key, a regex against
 * `rawKey=decodedValue`. Both asymmetries are uBO's — see `QueryParam` — and getting either side
 * wrong shows up as removing a parameter the rule never named, in both directions.
 */
function valueMatches(value: ValueMatcher, param: QueryParam): boolean {
  switch (value.kind) {
    case 'all':
      return true;
    // Case-sensitive, like uBO: query parameter names are compared verbatim.
    case 'name':
      return param.rawKey === value.name;
    case 'not-name':
      return param.rawKey !== value.name;
    case 'regex':
      return testStateless(value.re, param.pair);
    case 'not-regex':
      return !testStateless(value.re, param.pair);
  }
}

/**
 * `.test()` on a `g` or `y` regex advances `lastIndex`, so the same rule gave a different answer
 * per parameter and which ones survived depended on how many there were and in what order —
 * measured, `$removeparam=/utm_/g` on four `utm_*` params removed the first and third only.
 * Resetting makes each parameter an independent question, which is what uBO asks.
 */
function testStateless(re: RegExp, subject: string): boolean {
  if (re.global || re.sticky) re.lastIndex = 0;
  return re.test(subject);
}

/** One query param, in both forms the filter matcher and identity builder need. */
export interface QueryParam {
  /** Decoded name and value — what the extension shows the user. */
  name: string;
  value: string;
  /**
   * The key exactly as it appears in the URL. uBO splits the raw query itself and compares a
   * `$removeparam=name` against THIS, not against the decoded name, so `utm%5Fsource=x` is not
   * matched by `$removeparam=utm_source` and is matched by `$removeparam=utm%5Fsource`.
   */
  rawKey: string;
  /**
   * `rawKey=decodeURIComponent(rawValue)` — exactly the string uBO tests a regex value against
   * (`static-net-filtering.js`: `for (const [key, raw] of params) { value =
   * decodeURIComponent(raw); re.test(`${key}=${value}`) }`). The asymmetry is uBO's, not ours:
   * the key stays raw while the value is decoded once.
   */
  pair: string;
  /** Original segment without reconstruction, including whether it had an `=`. */
  raw: string;
  /** Position among every `&`-separated segment, including empty ones. */
  segmentIndex: number;
}

/**
 * The query as both consumers need it: decoded for display, raw-keyed and value-decoded for
 * matching, and with the segment index the key builder removes by.
 *
 * Positional zipping is safe because BOTH sides come from `url.search`: the URL standard derives
 * `searchParams` from that exact string by splitting on `&` and dropping empty sequences, so the
 * counts are equal by construction. It was not safe when the segments came from the input string
 * instead — the parser deletes tabs and newlines, so a segment made only of those existed on one
 * side and not the other, shifted the pairing, and made the key builder delete the wrong
 * parameter. Do not reintroduce a second source for this.
 */
export function queryParamsOf(url: URL): QueryParam[] {
  const search = url.search;
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const segments = raw.split('&');
  const nonEmpty = segments
    .map((piece, segmentIndex) => ({ piece, segmentIndex }))
    .filter(({ piece }) => piece !== '');
  const out: QueryParam[] = [];
  let i = 0;
  url.searchParams.forEach((value, name) => {
    const original = nonEmpty[i++];
    const piece = original?.piece ?? `${name}=${value}`;
    // Split on the FIRST `=`, the way uBO splits the raw query; a segment with no `=` has an
    // empty raw value, which is also what uBO records for it.
    const eq = piece.indexOf('=');
    const rawKey = eq < 0 ? piece : piece.slice(0, eq);
    const rawValue = eq < 0 ? '' : piece.slice(eq + 1);
    let decodedValue = rawValue;
    try {
      decodedValue = decodeURIComponent(rawValue);
    } catch {
      // A lone `%` is not decodable; uBO swallows the same throw and keeps the raw text.
    }
    out.push({
      name,
      value,
      rawKey,
      pair: `${rawKey}=${decodedValue}`,
      raw: piece,
      segmentIndex: original?.segmentIndex ?? i - 1,
    });
  });
  return out;
}

export interface QueryHit {
  filter: Filter;
  /** The param name, or `*` for a bare `$removeparam` that took the whole query. */
  param: string;
}

export interface QueryDecision {
  /** Parallel to the input: false means the param is dropped from the key. */
  keep: boolean[];
  /** Rules that removed something — the tester's and the counter's data source. */
  removedBy: QueryHit[];
  /** Exceptions that saved a param from removal. */
  sparedBy: QueryHit[];
}

/**
 * Which query params survive.
 *
 * uBO's model, and it is not the intuitive one: an `@@` exception does NOT re-match parameters to
 * carve them out of a removal. Exceptions and removals are keyed on their `$removeparam` VALUE
 * TEXT, and an exception cancels a removal only when the two strings are identical
 * (`matchAndFetchModifiers`: `if (toAdd.has(key)) toAdd.delete(key); else toRemove.delete(key)`).
 * A bare `@@…$removeparam` — the empty value — is the one blanket case and cancels everything.
 *
 * So `@@||example.com^$removeparam=utm_source` does not spare `utm_source` from
 * `$removeparam=/^utm_/`; it only cancels another `$removeparam=utm_source`. Resolving exceptions
 * per parameter instead kept a parameter uBO removes, which is the direction that matters: a rule
 * that behaves differently here than in uBO is the one thing this subset must never do.
 *
 * Once the surviving removals are known, they apply additively, parameter by parameter.
 */
export function decideQuery(
  compiled: CompiledFilters,
  url: string,
  hostname: string,
  params: QueryParam[],
): QueryDecision {
  const decision: QueryDecision = { keep: params.map(() => true), removedBy: [], sparedBy: [] };
  if (params.length === 0) return decision;

  const blocks = collect(compiled.block, url, hostname);
  if (blocks.length === 0) return decision;
  const allows = collect(compiled.allow, url, hostname);

  // A bare `@@…$removeparam` disables removal on this URL outright, which is the
  // idiomatic "never touch this site" escape hatch.
  const blanketAllow = allows.find((filter) => filter.valueText === '');
  if (blanketAllow) {
    decision.sparedBy.push({ filter: blanketAllow, param: '*' });
    return decision;
  }

  const cancelled = new Map<string, Filter>();
  for (const allow of allows) cancelled.set(allow.valueText, allow);

  const effective: Filter[] = [];
  for (const block of blocks) {
    const canceller = cancelled.get(block.valueText);
    if (canceller) {
      // Recorded so the options-page tester can still name the exception that did this, even
      // though what it cancelled is a whole rule rather than one parameter.
      decision.sparedBy.push({ filter: canceller, param: block.valueText || '*' });
      continue;
    }
    effective.push(block);
  }
  if (effective.length === 0) return decision;

  params.forEach((param, i) => {
    const remover = effective.find((filter) => valueMatches(filter.value, param));
    if (!remover) return;
    decision.keep[i] = false;
    decision.removedBy.push({ filter: remover, param: param.name });
  });

  return decision;
}
