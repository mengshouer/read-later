import type { Subscription } from './types';
import type { SubscriptionData } from './storage';
import * as store from './storage';
import { compileFilters } from './filters';

/**
 * Subscribed filter lists.
 *
 * WHY SUBSCRIPTIONS AND NOT A BUNDLED SNAPSHOT: the useful lists are ~3,800 lines and
 * are updated weekly, so a copy shipped inside the extension starts rotting the day it
 * is built. Keeping them out of the user's own rule text also means "my rules" stays
 * something a person can read — which is the whole point of the format change.
 *
 * WHAT IS REVOCABLE, AND WHAT IS NOT. `enabled` takes a list out of every future save
 * immediately while keeping its text, so switching back is instant and offline. What no
 * switch can undo is a merge that already happened: two different URLs collapsing onto
 * one key discards one of them (see `planRecompute`). That is why there is no "roll back
 * to the previous version" button — it would revert 42 good changes to undo one bad rule,
 * the next auto-update would fetch the bad version straight back, and the item would
 * still be gone. The line-level diff of each update is kept instead: it names the rule to
 * write an `@@` exception for, and an exception survives every future update.
 */

/**
 * Fetched text is capped so a wrong URL cannot fill storage. EasyList is ~3 MB.
 *
 * Two constants because there are two places to measure and each name says which one it is.
 * `MAX_LIST_BYTES` is checked against `Content-Length` before the body is read, so an oversized
 * list is refused without ever being materialised. `MAX_LIST_CHARS` is the backstop for a
 * response that declares no length: by then the text is in memory anyway, and `String.length`
 * counts UTF-16 code units rather than bytes — for non-ASCII text that is *fewer* units than
 * bytes, so this cap on its own would let roughly 3× the intended size through.
 */
const MAX_LIST_BYTES = 5 * 1024 * 1024;
const MAX_LIST_CHARS = 5 * 1024 * 1024;
/** How long to wait before treating a list as stale, when it does not say itself. */
export const DEFAULT_EXPIRES_HOURS = 72;
/** Diff lines kept for display. The true totals are stored separately, never rounded. */
const MAX_DIFF_LINES = 300;

export interface ListPreset {
  url: string;
  /** i18n keys for the name and the one-line description shown under it. */
  nameKey: 'sub.presetAdguardName' | 'sub.presetSupplementName';
  descriptionKey: 'sub.presetAdguardDesc' | 'sub.presetSupplementDesc';
}

/**
 * The list offered by name in the empty state. The `/ublock/` build is deliberate: it is
 * uBO-flavoured, so it stays inside the syntax subset this extension implements, while
 * the `/chromium/` build of the same filter uses AdGuard-only options we would have to
 * report as unsupported.
 */
export const ADGUARD_URL_TRACKING = 'https://filters.adtidy.org/extension/ublock/filters/17.txt';

/**
 * Order is the display order in the options page. The bundled list is first because it is
 * the one that needs no permission and no network — the shortest path to "my URLs are being
 * cleaned" — and the upstream list follows it.
 */
export const PRESETS: readonly ListPreset[] = [
  {
    url: '/filters/supplement.txt',
    nameKey: 'sub.presetSupplementName',
    descriptionKey: 'sub.presetSupplementDesc',
  },
  {
    url: ADGUARD_URL_TRACKING,
    nameKey: 'sub.presetAdguardName',
    descriptionKey: 'sub.presetAdguardDesc',
  },
];

/** Bundled lists are addressed by extension-relative path, so they need no permission. */
export function isBundled(url: string): boolean {
  return url.startsWith('/');
}

/**
 * The match pattern to request, and later to hand back, for a list fetched over the network.
 * `null` means "no permission is involved": a bundled list is an extension-relative path, and
 * anything that is not http(s) is not fetchable by us at all.
 *
 * Exported and pure because it decides a DESTRUCTIVE action — the options page revokes an origin
 * when the last list using it is unsubscribed — and because both the grant and the revoke path
 * must compute the identical string or one of them acts on the wrong origin.
 *
 * `URL.origin` carries the port when it is not the default, which narrows the request rather than
 * widening it; Chrome match patterns accept a port as an optional component.
 */
export function permissionOrigin(url: string): string | null {
  if (isBundled(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? `${parsed.origin}/*` : null;
  } catch {
    return null;
  }
}

/** A row in the options page's rule list. */
export type ListRow =
  /** An offered list that is not subscribed to yet. */
  | { kind: 'offer'; preset: ListPreset }
  /** A subscribed list. `preset` is set when it is one of the offered ones. */
  | { kind: 'list'; preset: ListPreset | null; subscription: Subscription };

/**
 * The lists you have, then the ones on offer.
 *
 * Presets being unconditional rows is the point. The first version rendered only the lists
 * you had and pushed the rest behind a bare button beside the "add a URL" field, so after
 * subscribing to just the bundled list the way to add the AdGuard one was technically
 * present and effectively invisible.
 *
 * What was wrong was the *order*: presets came in `PRESETS` order whether subscribed or not,
 * so an inert row with a Subscribe button sat above the list actually cleaning your URLs.
 * Sorting by state instead answers "what is in effect?" before "what else can I add?", and
 * it lands the offers directly above the add-by-URL field — every way to add a list ends up
 * in one place. Nothing subscribed yet is unchanged: every row is an offer, bundled first.
 */
export function listRows(subscriptions: readonly Subscription[]): ListRow[] {
  const presetIds = PRESETS.map((preset) => subscriptionId(preset.url));
  const lists: ListRow[] = [];
  const offers: ListRow[] = [];

  PRESETS.forEach((preset, i) => {
    const subscription = subscriptions.find((s) => s.id === presetIds[i]);
    if (subscription) lists.push({ kind: 'list', preset, subscription });
    else offers.push({ kind: 'offer', preset });
  });
  // Added by URL: always subscribed by definition, and kept in the order they were added.
  for (const subscription of subscriptions) {
    if (!presetIds.includes(subscription.id)) {
      lists.push({ kind: 'list', preset: null, subscription });
    }
  }

  return [...lists, ...offers];
}

/**
 * Stable, filesystem-safe id. A hash is appended because the readable slug is truncated
 * and two lists on the same host must not collide onto one storage key.
 */
export function subscriptionId(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const slug = url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'list'}-${hash.toString(36)}`;
}

// ---------------------------------------------------------------- list metadata

export interface ListMeta {
  title: string | null;
  version: string | null;
  expiresHours: number | null;
}

/**
 * The header name, once the surrounding whitespace is gone. A single anchored quantifier over
 * one character class — no second quantifier to share characters with, so it cannot backtrack
 * super-linearly. That property is the whole point; see `parseListMeta`.
 */
const HEADER_NAME = /^[A-Za-z ]+$/;

/**
 * Reads the `! Title:` / `! Version:` / `! Expires:` headers every filter list already
 * carries. This is why there is no metadata convention of our own to invent: the
 * ecosystem has one, `! Expires: 5 days` included, so a list gets to state its own
 * update frequency instead of us hardcoding a guess for it.
 *
 * SPLIT OUT OF ONE REGEX ON PURPOSE. This used to be
 * `/^!\s*([A-Za-z ]+?)\s*:\s*(.+)$/`, where `\s*` and `[A-Za-z ]` both match a space — two
 * quantifiers competing for the same characters, which is the textbook shape for quadratic
 * backtracking. A line with no colon forces the engine to try every split: measured on
 * `'!' + ' '.repeat(n) + 'X'`, n=2000 took 2.9 s and n=4000 took 22.9 s. `split(/\r?\n/, 100)`
 * above caps the line COUNT and says nothing about line LENGTH, and this runs from
 * `updateSubscription` *after* `validateListText` has already approved the body — so a remote
 * list could hang the worker on a header it never even had to spell correctly. The same input
 * is now 0 ms.
 *
 * Matching `:` by index instead removes the ambiguity rather than hiding it. Equivalence was
 * checked before the swap, on the whole `ListMeta` output rather than on the regex: 34 curated
 * spellings (`!Title:`, `! Title :`, `!  Homepage :`, `! Title\t:`, tabs inside the name,
 * empty values, repeated headers) plus 400,000 fuzzed strings over `! : \t` and letters —
 * zero differences. Two subtleties that equivalence depends on, both learned from a mismatch
 * the check caught: the old `\s*` pair stripped whitespace on BOTH sides of the name (so
 * `! Title\t: x` did parse, and trimming only the front broke it), while whitespace *inside*
 * the name still disqualifies the line, because `[A-Za-z ]+?` never matched a tab.
 */
export function parseListMeta(text: string): ListMeta {
  const meta: ListMeta = { title: null, version: null, expiresHours: null };
  const lines = text.split(/\r?\n/, 100);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.charCodeAt(0) !== 0x21 /* ! */) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const rawName = trimmed.slice(1, colon).trim();
    if (rawName === '' || !HEADER_NAME.test(rawName)) continue;
    const value = trimmed.slice(colon + 1).trim();
    // The old pattern ended in `(.+)`, so a header with nothing after the colon was no header.
    if (value === '') continue;
    const name = rawName.toLowerCase();
    if (name === 'title' && meta.title === null) meta.title = value;
    else if (name === 'version' && meta.version === null) meta.version = value;
    else if (name === 'expires' && meta.expiresHours === null) {
      const amount = /^(\d+)\s*(day|hour)/i.exec(value);
      if (amount) {
        const n = Number.parseInt(amount[1] as string, 10);
        meta.expiresHours = (amount[2] as string).toLowerCase().startsWith('day') ? n * 24 : n;
      }
    }
  }
  return meta;
}

/** Rule lines only — comments and blanks are not part of what a list *does*. */
function ruleLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('!') && !l.startsWith('['));
}

export interface ListDiff {
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
}

/**
 * What changed between two fetches. `addedCount` / `removedCount` are the real totals
 * while the arrays are capped for display, so a truncated list is never presented as
 * the whole story.
 */
export function diffLists(previous: string, next: string): ListDiff {
  const before = new Set(ruleLines(previous));
  const after = new Set(ruleLines(next));
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of after) if (!before.has(line)) added.push(line);
  for (const line of before) if (!after.has(line)) removed.push(line);
  return {
    added: added.slice(0, MAX_DIFF_LINES),
    removed: removed.slice(0, MAX_DIFF_LINES),
    addedCount: added.length,
    removedCount: removed.length,
  };
}

// ---------------------------------------------------------------- validation

export type ListCheck = { ok: true; active: number } | { ok: false; reason: string };

/**
 * Rejects anything that is not a filter list, so a captive portal's login page or a
 * 404 body can never overwrite working rules. The caller keeps the previous text on
 * failure — a bad fetch must degrade to "stale", never to "empty".
 */
export function validateListText(text: string): ListCheck {
  if (text.length > MAX_LIST_CHARS) return { ok: false, reason: 'too-large' };
  if (/^\s*</.test(text)) return { ok: false, reason: 'looks-like-html' };
  const compiled = compileFilters([{ id: 'candidate', text }]);
  if (compiled.active === 0) return { ok: false, reason: 'no-usable-rules' };
  return { ok: true, active: compiled.active };
}

// ---------------------------------------------------------------- fetching

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    cache: 'no-cache',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  // Refuse before reading. `response.text()` materialises the whole body, so a size check placed
  // after it has already paid the memory — and auto-update re-fetches daily with nobody watching,
  // which is the path where a URL that grew or was replaced actually reaches us. Any static list
  // file declares its length; a chunked response does not, and `MAX_LIST_CHARS` catches that one.
  // `Number(null)` and `Number('')` are 0, and a malformed header is NaN, so all three fall
  // through to the backstop rather than being treated as oversized.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_LIST_BYTES) throw new Error('too-large');
  return response.text();
}

export type UpdateOutcome =
  | { ok: true; data: SubscriptionData; diff: ListDiff; firstFetch: boolean }
  | { ok: false; reason: string };

/**
 * Fetches, checks, diffs and stores one list. `now` is a parameter so the staleness
 * logic can be tested without a clock.
 */
export async function updateSubscription(
  subscription: Subscription,
  now: number = Date.now(),
): Promise<UpdateOutcome> {
  const previous = await store.getSubscriptionData(subscription.id);

  let text: string;
  try {
    text = await fetchText(subscription.url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Keep whatever we already had; only the error line is new.
    if (previous) await store.setSubscriptionData(subscription.id, { ...previous, error: reason });
    return { ok: false, reason };
  }

  const check = validateListText(text);
  if (!check.ok) {
    if (previous) await store.setSubscriptionData(subscription.id, { ...previous, error: check.reason });
    return { ok: false, reason: check.reason };
  }

  const meta = parseListMeta(text);
  const firstFetch = previous === null;
  // A first fetch has nothing to diff against, and reporting all 2,568 lines as "added"
  // would store the list twice for no information.
  const diff = firstFetch
    ? { added: [], removed: [], addedCount: 0, removedCount: 0 }
    : diffLists(previous.text, text);

  const data: SubscriptionData = {
    text,
    title: meta.title,
    version: meta.version,
    fetchedAt: now,
    expiresHours: meta.expiresHours,
    added: diff.added,
    removed: diff.removed,
    addedCount: diff.addedCount,
    removedCount: diff.removedCount,
    error: null,
  };
  await store.setSubscriptionData(subscription.id, data);
  return { ok: true, data, diff, firstFetch };
}

/** Whether a list has gone past the freshness window it declared for itself. */
export function isStale(data: SubscriptionData | null, now: number = Date.now()): boolean {
  if (data === null) return true;
  const hours = data.expiresHours ?? DEFAULT_EXPIRES_HOURS;
  return now - data.fetchedAt >= hours * 3600_000;
}

/**
 * Every list that auto-update is on for and that is past its window. Disabled lists are
 * skipped: leaving a list off should stop network traffic for it too, not just its rules.
 */
export async function dueSubscriptions(
  subscriptions: Subscription[],
  now: number = Date.now(),
): Promise<Subscription[]> {
  const candidates = subscriptions.filter((s) => s.autoUpdate && s.enabled);
  if (candidates.length === 0) return [];
  const stored = await store.getSubscriptionMap(candidates.map((s) => s.id));
  return candidates.filter((s) => isStale(stored.get(s.id) ?? null, now));
}
