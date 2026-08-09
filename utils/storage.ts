import { browser } from 'wxt/browser';
import type { DeletedBatch, Item, Progress, Settings, UpsertResult } from './types';
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS } from './types';
import type { CompiledFilters } from './filters';
import { normalizeUrl, titleFromUrl } from './normalize';

/**
 * Layout (Q3): one item per key, key = `i:` + normalized URL in plain text.
 * Dedup is therefore an O(1) `get`, and changing one item's status rewrites
 * only that item instead of the whole table.
 *
 *   storage.local    i:<urlKey> -> Item (status 'unread')   persistent
 *                    settings   -> Settings
 *                    sub:<id>   -> SubscriptionData         one key per list, see below
 *   storage.session  i:<urlKey> -> Item (status 'archived') dies with the browser (Q1)
 *                    lastStorageError -> string
 */
const ITEM_PREFIX = 'i:';
const SETTINGS_KEY = 'settings';
const ERROR_KEY = 'lastStorageError';
/**
 * A subscribed list's fetched text, one key per subscription. Deliberately NOT inside
 * `settings`: that object is rewritten whole on every `patchSettings`, so a 174 KB list
 * living there would turn flipping a checkbox into a 174 KB write.
 */
const SUB_PREFIX = 'sub:';
/** Session-scoped, so an undoable delete has the same lifetime as the archive (Q1). */
const DELETED_KEY = 'lastDeleted';
/**
 * The titles the background last actually wrote onto the menu items.
 *
 * Session-scoped on purpose: it describes the *running* service worker, not a preference. The
 * options page compares it against what the current settings should produce, which is the
 * only way to tell a stale worker from a working one — refreshing an extension page reloads
 * its own bundle but leaves the worker on whatever code it started with.
 */
const APPLIED_MENU_KEY = 'appliedMenuTitles';

export type Area = 'local' | 'session';

const keyOf = (urlKey: string) => ITEM_PREFIX + urlKey;

/**
 * Whether `ERROR_KEY` is currently parked, or `undefined` for "this JS context has not looked
 * yet". The distinction matters because this flag lives in module scope while the record lives
 * in `storage.session`, which outlives the service worker: a restarted worker starting from
 * plain `false` would skip the clear below and leave the badge red — and the unread count
 * hidden behind it — long after writes had started succeeding again.
 */
let errorFlagged: boolean | undefined;

/** Why a write failed. `quota` is the one the user can act on. */
export type StorageErrorCode = 'quota' | 'other';

export interface StorageError {
  code: StorageErrorCode;
  message: string;
}

/**
 * `storage.local.set` failures are silent by default — the write just doesn't
 * happen and the user believes it did. Every write goes through here so a
 * failure becomes visible (badge + popup banner) instead of a lost save.
 *
 * The cap is real (`unlimitedStorage` is not requested), so "full" is a reachable
 * end state rather than a freak accident, and it is the only failure with an obvious
 * remedy. Chrome words it "QUOTA_BYTES quota exceeded"; classifying it here is what
 * lets the banner say "storage is full" instead of quoting that at the user.
 */
async function guardedSet(area: Area, values: Record<string, unknown>): Promise<void> {
  try {
    await browser.storage[area].set(values);
    // A successful session write says nothing about persistent capacity. In particular,
    // archiving an item must not dismiss a still-valid local quota error.
    if (area !== 'local') return;
    // One session read per worker lifetime, not per write: only the first success after a
    // restart has to ask storage what the previous worker left behind.
    if (errorFlagged === undefined) errorFlagged = (await getLastStorageError()) !== null;
    if (errorFlagged) {
      errorFlagged = false;
      await browser.storage.session.remove(ERROR_KEY).catch(() => {});
    }
  } catch (error) {
    errorFlagged = true;
    const message = error instanceof Error ? error.message : String(error);
    const record: StorageError = { code: /quota/i.test(message) ? 'quota' : 'other', message };
    await browser.storage.session.set({ [ERROR_KEY]: record }).catch(() => {});
    throw error;
  }
}

export async function getLastStorageError(): Promise<StorageError | null> {
  const raw = await browser.storage.session.get(ERROR_KEY);
  const value = raw[ERROR_KEY];
  // A worker that started before this shape existed may still have a bare string parked.
  if (typeof value === 'string') return { code: 'other', message: value };
  if (value && typeof value === 'object' && typeof (value as StorageError).message === 'string') {
    return value as StorageError;
  }
  return null;
}

export async function clearLastStorageError(): Promise<void> {
  errorFlagged = false;
  await browser.storage.session.remove(ERROR_KEY).catch(() => {});
}

// ---------------------------------------------------------------- settings

export async function getSettings(): Promise<Settings> {
  const raw = await browser.storage.local.get(SETTINGS_KEY);
  const stored = raw[SETTINGS_KEY] as Partial<Settings> | undefined;
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  merged.schemaVersion = CURRENT_SCHEMA_VERSION;
  return merged;
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch };
  await guardedSet('local', { [SETTINGS_KEY]: next });
  return next;
}

// ---------------------------------------------------------------- subscriptions

/**
 * What a fetch produced. `added`/`removed` are the line-level diff of the last update,
 * kept *instead of* the previous copy of the list: a rollback button would revert 42
 * good changes to undo one bad rule, and the next auto-update would fetch the bad
 * version straight back. The diff, by contrast, points at the line to write an `@@`
 * exception for — which survives every future update.
 */
export interface SubscriptionData {
  text: string;
  /** From the list's own `! Title:` header. */
  title: string | null;
  version: string | null;
  fetchedAt: number;
  /** From `! Expires:`, in hours. null when the list does not say. */
  expiresHours: number | null;
  added: string[];
  removed: string[];
  /** True totals. The arrays above are capped for display; these are never rounded. */
  addedCount: number;
  removedCount: number;
  /** Last fetch failure. The previous text is kept, so a bad fetch never wipes rules. */
  error: string | null;
}

export async function getSubscriptionData(id: string): Promise<SubscriptionData | null> {
  const key = SUB_PREFIX + id;
  const raw = await browser.storage.local.get(key);
  return (raw[key] as SubscriptionData | undefined) ?? null;
}

export async function getSubscriptionMap(ids: string[]): Promise<Map<string, SubscriptionData>> {
  if (ids.length === 0) return new Map();
  const keys = ids.map((id) => SUB_PREFIX + id);
  const raw = await browser.storage.local.get(keys);
  const out = new Map<string, SubscriptionData>();
  for (const id of ids) {
    const data = raw[SUB_PREFIX + id] as SubscriptionData | undefined;
    if (data) out.set(id, data);
  }
  return out;
}

export async function setSubscriptionData(id: string, data: SubscriptionData): Promise<void> {
  await guardedSet('local', { [SUB_PREFIX + id]: data });
}

export async function removeSubscriptionData(id: string): Promise<void> {
  await browser.storage.local.remove(SUB_PREFIX + id);
}

// ---------------------------------------------------------------- reads

function collect(bag: Record<string, unknown>, status: Item['status']): Item[] {
  const items: Item[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (!key.startsWith(ITEM_PREFIX)) continue;
    if (!value || typeof value !== 'object') continue;
    items.push({ ...(value as Item), status });
  }
  return items;
}

export async function listUnread(): Promise<Item[]> {
  return collect(await browser.storage.local.get(null), 'unread');
}

export async function listArchived(): Promise<Item[]> {
  return collect(await browser.storage.session.get(null), 'archived');
}

/**
 * Item keys in one area, without deserialising a single value where the browser allows it.
 *
 * `get(null)` hands back every *value* too, so counting items for the badge used to deserialise
 * every subscribed filter list — the cap is 5 MB — just to produce one number, and it did that on
 * every save, archive, delete and storage event. `getKeys` is Chrome 130+ / Firefox 140+; older
 * builds fall back to the full read, which is exactly what this did before.
 *
 * One deliberate difference from `collect`: that skips an `i:` key whose value is not an object,
 * and a key-only enumeration cannot. Nothing writes a non-`Item` under this prefix, so the two
 * agree in practice — the guard over there is against foreign data, not against our own writes.
 */
async function itemKeys(area: 'local' | 'session'): Promise<string[]> {
  const bag = browser.storage[area] as { getKeys?: () => Promise<string[]> };
  const keys = bag.getKeys
    ? await bag.getKeys()
    : Object.keys(await browser.storage[area].get(null));
  return keys.filter((key) => key.startsWith(ITEM_PREFIX));
}

export async function unreadCount(): Promise<number> {
  return (await itemKeys('local')).length;
}

export async function findItem(urlKey: string): Promise<{ item: Item; area: Area } | null> {
  const key = keyOf(urlKey);
  const local = await browser.storage.local.get(key);
  if (local[key]) return { item: { ...(local[key] as Item), status: 'unread' }, area: 'local' };
  const session = await browser.storage.session.get(key);
  if (session[key]) return { item: { ...(session[key] as Item), status: 'archived' }, area: 'session' };
  return null;
}

// ---------------------------------------------------------------- writes

export interface UpsertDraft {
  urlKey: string;
  url: string;
  title: string;
  progress: Progress | null;
}

/**
 * Save is an upsert, not an insert — "read half of it, tuck it away again"
 * is the core gesture, so hitting an existing key must update rather than refuse:
 *   status   archived -> unread (revived)
 *   progress new snapshot wins, except a <5% snapshot never clobbers a real
 *            prior position (guards against a failed text-fragment landing at
 *            page top and reporting 0%)
 *   addedAt  unchanged, so sort order stays stable; updatedAt moves
 */
export async function upsert(draft: UpsertDraft): Promise<UpsertResult> {
  const key = keyOf(draft.urlKey);
  const now = Date.now();
  const found = await findItem(draft.urlKey);

  if (!found) {
    const item: Item = {
      urlKey: draft.urlKey,
      url: draft.url,
      title: draft.title,
      addedAt: now,
      updatedAt: now,
      status: 'unread',
      progress: draft.progress,
    };
    await guardedSet('local', { [key]: item });
    return {
      kind: 'created',
      item,
      previous: null,
      previousArea: null,
      progressChanged: draft.progress !== null,
      oldPercent: null,
      newPercent: draft.progress ? draft.progress.percent : null,
    };
  }

  const previous = found.item;
  const oldPercent = previous.progress ? previous.progress.percent : null;
  const newPercent = draft.progress ? draft.progress.percent : null;

  let progress = previous.progress;
  let progressChanged = false;
  if (draft.progress) {
    const wouldClobber = oldPercent !== null && draft.progress.percent < 0.05 && oldPercent > draft.progress.percent;
    if (!wouldClobber) {
      progress = draft.progress;
      progressChanged = oldPercent !== newPercent;
    }
  }

  const item: Item = {
    ...previous,
    url: draft.url,
    title: previous.titleEdited ? previous.title : draft.title || previous.title,
    updatedAt: now,
    status: 'unread',
    progress,
  };

  await guardedSet('local', { [key]: item });
  if (found.area === 'session') await browser.storage.session.remove(key);

  return {
    kind: 'updated',
    item,
    previous,
    previousArea: found.area,
    progressChanged,
    oldPercent,
    newPercent,
  };
}

/**
 * Undo for the toast / confirm flow: put the pre-write state back exactly.
 *
 * Gives up instead of overwriting when the key has moved on since the save, which is the rule
 * `undoDelete` already states: whatever is there now is the newer truth, and a stale undo must
 * not clobber it. `updatedAt` serves as that write's version stamp — every in-place mutator
 * (`upsert`, `restoreItem`, `renameItem`) sets it to `Date.now()`, and the paths that leave it
 * alone (`archiveItem`, `deleteItems`) take the key out of `local` altogether, which this same
 * check sees.
 *
 * Two distinct failures without it. A second save inside the undo window was deleted outright by
 * the `remove(key)` below. And opening the item in between — which moves it local -> session —
 * left the `local` branch writing an unread copy back without touching the archive, so the same
 * URL showed up in both lists.
 */
export async function revertUpsert(result: UpsertResult): Promise<void> {
  const key = keyOf(result.item.urlKey);

  // Every branch of `upsert` writes to `local`, so that is where its trace has to be found.
  const current = (await browser.storage.local.get(key))[key] as Item | undefined;
  if (!current || current.updatedAt !== result.item.updatedAt) return;

  if (!result.previous || !result.previousArea) {
    await browser.storage.local.remove(key);
    return;
  }
  if (result.previousArea === 'session') {
    await guardedSet('session', { [key]: result.previous });
    await browser.storage.local.remove(key);
  } else {
    await guardedSet('local', { [key]: result.previous });
  }
}

/** Q1: opening an item archives it into session storage, so it dies with the browser. */
export async function archiveItem(urlKey: string): Promise<void> {
  const key = keyOf(urlKey);
  const local = await browser.storage.local.get(key);
  const item = local[key] as Item | undefined;
  if (!item) return;
  await guardedSet('session', { [key]: { ...item, status: 'archived' } });
  await browser.storage.local.remove(key);
}

export async function restoreItem(urlKey: string): Promise<void> {
  const key = keyOf(urlKey);
  const session = await browser.storage.session.get(key);
  const item = session[key] as Item | undefined;
  if (!item) return;
  await guardedSet('local', { [key]: { ...item, status: 'unread', updatedAt: Date.now() } });
  await browser.storage.session.remove(key);
}

/**
 * Deletes items, keeping them in session storage so the delete can be taken back.
 *
 * Deleting was the only destructive thing in the list with no way out: a save has its undo
 * toast (D9) and an open only archives (Q1). One batch is remembered — the next delete
 * replaces it, and the browser closing clears it, which is the same lifetime as the archive.
 */
export async function deleteItems(urlKeys: string[]): Promise<void> {
  if (urlKeys.length === 0) return;
  const keys = urlKeys.map(keyOf);
  const [local, session] = await Promise.all([
    browser.storage.local.get(keys),
    browser.storage.session.get(keys),
  ]);

  const batch: DeletedBatch = { at: Date.now(), entries: [] };
  for (const key of keys) {
    const unread = local[key] as Item | undefined;
    const archived = session[key] as Item | undefined;
    if (unread) batch.entries.push({ item: unread, area: 'local' });
    else if (archived) batch.entries.push({ item: archived, area: 'session' });
  }

  if (batch.entries.length === 0) {
    await clearLastDeleted();
    return;
  }

  // Deletion promises an Undo. Establish that recovery state before removing either copy;
  // if session storage cannot hold it, the delete aborts and the visible storage error tells
  // the user why. This can temporarily duplicate archived data, but never loses it.
  await guardedSet('session', { [DELETED_KEY]: batch });
  await browser.storage.local.remove(keys);
  await browser.storage.session.remove(keys);
}

export async function getLastDeleted(): Promise<DeletedBatch | null> {
  const raw = await browser.storage.session.get(DELETED_KEY);
  const batch = raw[DELETED_KEY] as DeletedBatch | undefined;
  return batch && batch.entries.length > 0 ? batch : null;
}

/** See `APPLIED_MENU_KEY`. Never guarded: a failure here must not look like a data problem. */
export async function setAppliedMenuTitles(titles: string[]): Promise<void> {
  await browser.storage.session.set({ [APPLIED_MENU_KEY]: titles }).catch(() => {});
}

export async function getAppliedMenuTitles(): Promise<string[] | null> {
  const raw = await browser.storage.session.get(APPLIED_MENU_KEY);
  const titles = raw[APPLIED_MENU_KEY];
  return Array.isArray(titles) && titles.every((t) => typeof t === 'string') ? (titles as string[]) : null;
}

export async function clearLastDeleted(): Promise<void> {
  await browser.storage.session.remove(DELETED_KEY).catch(() => {});
}

/**
 * Puts the last deleted batch back where it came from. Returns how many items returned.
 *
 * A key that already exists again is skipped rather than overwritten: if you deleted a URL
 * and then saved it afresh, the new save is the newer truth and undo must not clobber it.
 */
export async function undoDelete(): Promise<number> {
  const batch = await getLastDeleted();
  if (!batch) return 0;

  const keys = batch.entries.map((entry) => keyOf(entry.item.urlKey));
  const [local, session] = await Promise.all([
    browser.storage.local.get(keys),
    browser.storage.session.get(keys),
  ]);

  const toLocal: Record<string, Item> = {};
  const toSession: Record<string, Item> = {};
  for (const { item, area } of batch.entries) {
    const key = keyOf(item.urlKey);
    if (local[key] || session[key]) continue;
    if (area === 'session') toSession[key] = item;
    else toLocal[key] = item;
  }

  const restored = Object.keys(toLocal).length + Object.keys(toSession).length;
  if (Object.keys(toLocal).length > 0) await guardedSet('local', toLocal);
  if (Object.keys(toSession).length > 0) await guardedSet('session', toSession);
  await clearLastDeleted();
  return restored;
}

export async function renameItem(urlKey: string, title: string): Promise<void> {
  const found = await findItem(urlKey);
  if (!found) return;
  const next: Item = { ...found.item, title, titleEdited: true, updatedAt: Date.now() };
  await guardedSet(found.area, { [keyOf(urlKey)]: next });
}

// ---------------------------------------------------------------- footprint

/**
 * Exact on Chrome. Firefox only shipped `storage.local.getBytesInUse` in 144,
 * so fall back to measuring the serialised payload ourselves.
 *
 * `keys` narrows it to a subset — which is how the reading list and the subscribed
 * filter lists get told apart. They DO share one 10 MB cap, so a big list genuinely
 * costs you items; showing one conflated number would hide which of the two to shrink.
 */
export async function bytesInUse(keys?: string[]): Promise<number> {
  if (keys && keys.length === 0) return 0;
  const area = browser.storage.local as unknown as {
    getBytesInUse?: (keys: string[] | string | null) => Promise<number>;
  };
  if (typeof area.getBytesInUse === 'function') {
    try {
      return await area.getBytesInUse(keys ?? null);
    } catch {
      // fall through to the estimate
    }
  }
  const all = await browser.storage.local.get(keys ?? null);
  const encoder = new TextEncoder();
  let total = 0;
  for (const [key, value] of Object.entries(all)) {
    total += encoder.encode(key).length + encoder.encode(JSON.stringify(value)).length;
  }
  return total;
}

/** What the subscribed lists cost, so it can be shown apart from the reading list. */
export async function subscriptionBytes(ids: string[]): Promise<number> {
  return bytesInUse(ids.map((id) => SUB_PREFIX + id));
}

// ---------------------------------------------------------------- merge / rekey

/** Conflict resolution when two keys collapse into one (rule change or import). */
function mergeItems(a: Item, b: Item, status: Item['status'] = 'unread'): Item {
  const older = a.addedAt <= b.addedAt ? a : b;
  const newer = a.updatedAt >= b.updatedAt ? a : b;
  /*
   * Furthest read wins, but an anchor is never traded away for a bigger number.
   *
   * An empty `textStart` means "percentage known, position not recoverable" — the shape
   * `scripts/convert-legacy.mjs` produces, because the old extension stored a scroll offset and
   * nothing else. `captureSnapshot` never emits an empty one, so it is an unambiguous signal.
   * Comparing on percent alone therefore let a strict downgrade win: measured, importing a
   * converted `{percent: 0.95, textStart: ''}` over a natively saved
   * `{percent: 0.9, textStart: 'the real anchor text'}` replaced a working restore with a number.
   */
  const anchored = (item: Item) => item.progress !== null && item.progress.textStart !== '';
  let bestProgress: Progress | null;
  if (anchored(a) !== anchored(b)) {
    bestProgress = anchored(a) ? a.progress : b.progress;
  } else {
    bestProgress =
      (a.progress?.percent ?? -1) >= (b.progress?.percent ?? -1) ? a.progress : b.progress;
  }
  const titled = a.titleEdited ? a : b.titleEdited ? b : newer;
  return {
    urlKey: a.urlKey,
    url: newer.url,
    title: titled.title,
    titleEdited: a.titleEdited || b.titleEdited,
    addedAt: older.addedAt,
    updatedAt: newer.updatedAt,
    status,
    progress: bestProgress,
  };
}

/**
 * The price of using the normalized URL as the primary key: when the filters change,
 * every key must be recomputed. Possible only because `url` is kept verbatim.
 */
interface LocatedItem {
  item: Item;
  area: Area;
}

interface RekeyComputation {
  next: Map<string, LocatedItem>;
  rekeyed: number;
  merged: number;
  losing: Array<{ url: string; title: string; intoUrl: string }>;
}

function computeRekey(entries: LocatedItem[], filters: CompiledFilters): RekeyComputation {
  const next = new Map<string, LocatedItem>();
  const out: RekeyComputation = { next, rekeyed: 0, merged: 0, losing: [] };

  for (const { item, area } of entries) {
    const normalized = normalizeUrl(item.url, filters);
    const newKey = normalized ? normalized.urlKey : item.urlKey;
    if (newKey !== item.urlKey) out.rekeyed++;
    const candidate: Item = {
      ...item,
      urlKey: newKey,
      status: area === 'local' ? 'unread' : 'archived',
    };
    const existing = next.get(newKey);
    if (existing) {
      out.merged++;
      // An unread copy wins status over an archived duplicate. Content still follows the
      // normal merge rules: edited title first, then newer title, plus the best progress.
      const targetArea: Area = existing.area === 'local' || area === 'local' ? 'local' : 'session';
      const survivor = mergeItems(
        existing.item,
        candidate,
        targetArea === 'local' ? 'unread' : 'archived',
      );
      const loser = survivor.url === existing.item.url ? candidate : existing.item;
      if (loser.url !== survivor.url) {
        out.losing.push({ url: loser.url, title: loser.title, intoUrl: survivor.url });
      }
      next.set(newKey, { item: survivor, area: targetArea });
    } else {
      next.set(newKey, { item: candidate, area });
    }
  }

  return out;
}

async function listLocatedItems(): Promise<LocatedItem[]> {
  const [unread, archived] = await Promise.all([listUnread(), listArchived()]);
  return [
    ...unread.map((item): LocatedItem => ({ item, area: 'local' })),
    ...archived.map((item): LocatedItem => ({ item, area: 'session' })),
  ];
}

export interface RekeyPlan {
  rekeyed: number;
  merged: number;
  /** URLs a merge would discard. Shown for confirmation *before* anything is written. */
  losing: Array<{ url: string; title: string; intoUrl: string }>;
}

/**
 * What a recompute would do, without doing it. Exists because the merge step cannot be
 * undone: disabling a subscription takes its rules out of every future save, but no
 * switch brings back a URL that a merge already discarded.
 */
export async function planRecompute(filters: CompiledFilters): Promise<RekeyPlan> {
  const { rekeyed, merged, losing } = computeRekey(await listLocatedItems(), filters);
  return { rekeyed, merged, losing };
}

/** What a recompute did, or why it declined to write anything. */
export type RecomputeOutcome =
  | { ok: true; rekeyed: number; merged: number }
  | { ok: false; unnamed: Array<{ url: string; title: string; intoUrl: string }> };

/**
 * Writes every destination first and prunes old keys second, including moves between
 * persistent unread storage and the session archive. A failure can leave a duplicate,
 * but never makes the only copy disappear.
 *
 * `named` is the `losing` list from the `planRecompute` the user actually confirmed. Both the
 * items and the filters are read again in here, and neither is frozen while the preview sits on
 * screen. A URL about to be discarded that the preview did not name refuses the write.
 */
export async function recomputeAllKeys(
  filters: CompiledFilters,
  named?: readonly string[],
): Promise<RecomputeOutcome> {
  const entries = await listLocatedItems();
  const { next, rekeyed, merged, losing } = computeRekey(entries, filters);

  if (named) {
    const promised = new Set(named);
    const unnamed = losing.filter((entry) => !promised.has(entry.url));
    if (unnamed.length) return { ok: false, unnamed };
  }

  const localPayload: Record<string, Item> = {};
  const sessionPayload: Record<string, Item> = {};
  next.forEach(({ item, area }, urlKey) => {
    (area === 'local' ? localPayload : sessionPayload)[keyOf(urlKey)] = item;
  });

  if (Object.keys(localPayload).length) await guardedSet('local', localPayload);
  if (Object.keys(sessionPayload).length) await guardedSet('session', sessionPayload);

  const staleLocal = entries
    .filter((entry) => entry.area === 'local')
    .map((entry) => keyOf(entry.item.urlKey))
    .filter((key) => !(key in localPayload));
  const staleSession = entries
    .filter((entry) => entry.area === 'session')
    .map((entry) => keyOf(entry.item.urlKey))
    .filter((key) => !(key in sessionPayload));
  if (staleLocal.length) await browser.storage.local.remove(staleLocal);
  if (staleSession.length) await browser.storage.session.remove(staleSession);

  return { ok: true, rekeyed, merged };
}

// ---------------------------------------------------------------- export / import

export interface ExportPayload {
  format: 'read-later';
  schemaVersion: number;
  exportedAt: string;
  /** Unread only — settings and the session archive are intentionally not a backup. */
  items: Item[];
}

export async function exportAll(): Promise<ExportPayload> {
  return {
    format: 'read-later',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    items: await listUnread(),
  };
}

export interface ImportReport {
  created: number;
  merged: number;
  skipped: number;
}

export type ImportErrorCode = 'invalid-object' | 'missing-items' | 'newer-schema';

export class ImportPayloadError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportPayloadError';
  }
}

const MAX_DATE_MS = 8_640_000_000_000_000;

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_DATE_MS
    ? value
    : fallback;
}

function sanitizeProgress(value: unknown): Progress | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.scrollY !== 'number' ||
    !Number.isFinite(raw.scrollY) ||
    raw.scrollY < 0 ||
    typeof raw.docHeight !== 'number' ||
    !Number.isFinite(raw.docHeight) ||
    raw.docHeight <= 0 ||
    raw.scrollY > raw.docHeight ||
    typeof raw.percent !== 'number' ||
    !Number.isFinite(raw.percent) ||
    raw.percent < 0 ||
    raw.percent > 1 ||
    typeof raw.textStart !== 'string' ||
    (raw.textEnd !== undefined && typeof raw.textEnd !== 'string')
  ) {
    return null;
  }
  return {
    scrollY: raw.scrollY,
    docHeight: raw.docHeight,
    percent: raw.percent,
    textStart: raw.textStart,
    ...(typeof raw.textEnd === 'string' ? { textEnd: raw.textEnd } : {}),
  };
}

/**
 * Merges valid HTTP(S) items into the current unread list. Older exports may contain a
 * `settings` member; it is intentionally ignored because v0.1 backups cover unread items only.
 */
export async function importPayload(payload: unknown, filters: CompiledFilters): Promise<ImportReport> {
  const report: ImportReport = { created: 0, merged: 0, skipped: 0 };
  if (!payload || typeof payload !== 'object') {
    throw new ImportPayloadError('invalid-object', 'The file does not contain a JSON object.');
  }

  const data = payload as { items?: unknown; schemaVersion?: unknown };
  if (!Array.isArray(data.items)) {
    throw new ImportPayloadError('missing-items', 'The backup is missing its items array.');
  }
  if (
    typeof data.schemaVersion === 'number' &&
    Number.isFinite(data.schemaVersion) &&
    data.schemaVersion > CURRENT_SCHEMA_VERSION
  ) {
    throw new ImportPayloadError(
      'newer-schema',
      `The backup schemaVersion=${data.schemaVersion} is newer than ${CURRENT_SCHEMA_VERSION}.`,
    );
  }

  const writes: Record<string, Item> = {};

  for (const value of data.items) {
    if (!value || typeof value !== 'object') {
      report.skipped++;
      continue;
    }
    const raw = value as Record<string, unknown>;
    if (typeof raw.url !== 'string') {
      report.skipped++;
      continue;
    }
    const normalized = normalizeUrl(raw.url, filters);
    if (!normalized) {
      report.skipped++;
      continue;
    }

    const now = Date.now();
    const addedAt = finiteTimestamp(raw.addedAt, now);
    const incoming: Item = {
      urlKey: normalized.urlKey,
      url: raw.url,
      title:
        typeof raw.title === 'string' && raw.title.trim().length > 0
          ? raw.title
          : titleFromUrl(raw.url),
      titleEdited: raw.titleEdited === true,
      addedAt,
      updatedAt: finiteTimestamp(raw.updatedAt, addedAt),
      status: 'unread',
      progress: sanitizeProgress(raw.progress),
    };

    const key = keyOf(normalized.urlKey);
    const staged = writes[key];
    const existing = staged ?? (await findItem(normalized.urlKey))?.item;
    if (existing) {
      writes[key] = mergeItems(existing, incoming);
      report.merged++;
    } else {
      writes[key] = incoming;
      report.created++;
    }
  }

  if (Object.keys(writes).length) await guardedSet('local', writes);
  // Anything revived by the import must leave the archive, or it would show twice.
  await browser.storage.session.remove(Object.keys(writes)).catch(() => {});
  return report;
}

export async function clearAllItems(): Promise<void> {
  const [localKeys, sessionKeys] = await Promise.all([itemKeys('local'), itemKeys('session')]);
  if (localKeys.length) await browser.storage.local.remove(localKeys);
  // Clear the previous delete batch too: an explicit Clear all is irreversible and must not
  // allow older items to reappear through the list footer afterwards.
  await browser.storage.session.remove([...sessionKeys, DELETED_KEY]);
}
