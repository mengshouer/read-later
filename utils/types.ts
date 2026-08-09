/**
 * Shared data shapes.
 *
 * Design note: nothing derived is persisted. `domain` / group key / favicon are
 * all recomputed from `url` at render time, because what produces them (the filter
 * rules for the key, the registrable domain for the group) can change at any time.
 * The only derived value we *do* persist is `urlKey`, because it is the storage
 * primary key — and that is exactly why we also keep `url` verbatim, so keys can
 * always be recomputed after a rule change (see `recomputeAllKeys`).
 */
import type { LocalePref } from './i18n';

/** A reading position snapshot, captured once at save time. Never auto-updated. */
export interface Progress {
  /** Absolute scroll offset when captured. Retained for future restore compatibility. */
  scrollY: number;
  /** scrollHeight when captured. Retained with scrollY for future compatibility. */
  docHeight: number;
  /** 0..1. Display only — never feeds any automatic decision. */
  percent: number;
  /** Leading text of the block at the viewport top. Primary restore path. */
  textStart: string;
  /** Trailing text of the same block, when needed to disambiguate. */
  textEnd?: string;
}

export type ItemStatus = 'unread' | 'archived';

export interface Item {
  /** Normalized URL. Primary key (stored under `i:<urlKey>`). */
  urlKey: string;
  /** Original URL, verbatim. Always what we open, and the source of truth for re-keying. */
  url: string;
  title: string;
  /** true once the user renamed it, so upsert stops overwriting the title. */
  titleEdited?: boolean;
  addedAt: number;
  updatedAt: number;
  status: ItemStatus;
  /** null when a text-fragment position could not be captured (feeds, PDFs, saved links). */
  progress: Progress | null;
}

export type SortField = 'addedAt' | 'updatedAt';
export type SortDir = 'asc' | 'desc';

/**
 * `storage.local`'s cap — a real one, because `unlimitedStorage` is deliberately not
 * requested. Everything persistent shares it: the reading list, the settings, and the
 * text of every subscribed filter list.
 *
 * It is surfaced as "used / limit" and nothing else. There are no warning tiers: the
 * number is on the footer of every list, so the growth is visible without being nagged
 * about, and a write that would exceed the cap fails — which is what the error banner is
 * for. Warning about a limit you can already see was noise.
 */
export const QUOTA_BYTES = 10 * 1024 * 1024;

export interface Settings {
  schemaVersion: number;
  /** 'auto' follows the browser UI language; the toggle writes 'en' or 'zh'. */
  locale: LocalePref;
  sortField: SortField;
  /** Q11: default 'asc' (oldest first) so the queue drains instead of only growing. */
  sortDir: SortDir;
  groupByDomain: boolean;
  collapsedGroups: string[];
  /**
   * The row-level Copy / Delete buttons. Off by default: they live at the row's right
   * edge, which is exactly where the pointer arrives when the popup opens under the
   * toolbar icon, and they are pure noise while scanning the queue. Select mode does
   * both in bulk regardless, so nothing becomes unreachable.
   *
   * The archive's per-row Restore is deliberately *not* gated by this — the archive is
   * a misclick buffer, and Restore is its only single-item way out.
   */
  rowActionsEnabled: boolean;
  /**
   * Open an item by navigating the tab the list was opened over, instead of adding a new
   * one — so reading the queue one item at a time stops meaning "new tab, switch to it,
   * close the old one" every time.
   *
   * Off by default: replacing whatever you were already looking at is not something to
   * start doing unasked. Ctrl/middle-click still adds a background tab either way, and the
   * full-tab list never reuses its own tab (see `openTargetFor`).
   */
  openInCurrentTab: boolean;
  /**
   * Close the tab after saving it with the page gesture (the context menu item, or whatever
   * key the user bound to `save-current-tab`) — the gesture is called Read *Later*, so "I am
   * done with this for now" normally means the tab should go away too.
   *
   * Off by default, and it never applies to saving a *link*: there the tab you are on is
   * not the thing you saved. The confirm button reads "Save and close" while this is on,
   * so the card never hides it.
   */
  closeTabAfterSavingPage: boolean;
  /**
   * Prefixed to both context menu items. Empty by default — nothing is preconfigured (R1).
   *
   * The point is where our entry sits in the right-click menu; see `utils/menu.ts` for why
   * the item title is what decides that, and why this is the one lever we can hand over.
   */
  menuPrefix: string;
  /**
   * The user's own filter rules, in uBlock Origin / AdGuard `$removeparam` syntax.
   * Ships empty on purpose: nothing is preconfigured and nothing is hidden, so whatever
   * normalises your URLs is text you can read. Curated sets are subscribed to, and their
   * text is kept out of here (see `subscriptions`) so it cannot be mistaken for yours.
   */
  filterText: string;
  /**
   * Subscribed filter lists — metadata only. The rule text itself lives under its own
   * storage key per subscription, because `patchSettings` rewrites this whole object and
   * a 174 KB list in here would turn every checkbox into a 174 KB write.
   */
  subscriptions: Subscription[];
  badgeEnabled: boolean;
}

/**
 * A subscribed list. `enabled` is the revocation path: turning it off takes the rules out
 * of every future save immediately while keeping the fetched text, so switching back is
 * instant and offline. `autoUpdate` off everywhere means no alarm is registered at all.
 */
export interface Subscription {
  /** Stable key for the stored text; derived from the URL when the subscription is added. */
  id: string;
  url: string;
  enabled: boolean;
  autoUpdate: boolean;
}

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  locale: 'auto',
  sortField: 'addedAt',
  sortDir: 'asc',
  groupByDomain: true,
  collapsedGroups: [],
  rowActionsEnabled: false,
  openInCurrentTab: false,
  closeTabAfterSavingPage: false,
  menuPrefix: '',
  filterText: '',
  subscriptions: [],
  badgeEnabled: true,
};

/**
 * A deleted batch, parked so the delete can be taken back.
 *
 * `area` is remembered per item because an archived item must go back to the archive, not
 * to the unread list. Session-scoped, so it dies with the browser like the archive itself.
 */
export interface DeletedBatch {
  at: number;
  entries: Array<{ item: Item; area: 'local' | 'session' }>;
}

/** What `upsert` did, so the caller can word its feedback and support undo. */
export interface UpsertResult {
  kind: 'created' | 'updated';
  item: Item;
  /** Pre-write state, for undo. null when it was a fresh insert. */
  previous: Item | null;
  /** Where `previous` lived, so undo can put it back in the right area. */
  previousArea: 'local' | 'session' | null;
  progressChanged: boolean;
  oldPercent: number | null;
  newPercent: number | null;
}
