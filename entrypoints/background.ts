import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { getMatcher } from '../utils/matcher';
import { dueSubscriptions, updateSubscription } from '../utils/subscriptions';
import { buildRestoreUrl, isSavableUrl, normalizeUrl, titleFromUrl } from '../utils/normalize';
import { shortLocation } from '../utils/display';
import { makeTranslate, resolveLocale } from '../utils/i18n';
import type { Locale, MessageKey, Translate } from '../utils/i18n';
import * as store from '../utils/storage';
import { MENU_SAVE_LINK, MENU_SAVE_PAGE, menuDefinitions, sanitizeMenuPrefix } from '../utils/menu';
import { PANEL_CSS, captureSnapshot, findLinkTitle, renderConfirmCard, renderToast } from '../utils/injected';
import type { ConfirmCardData, ToastData, UnrestorableReason } from '../utils/injected';
import type { Message, OpenTarget } from '../utils/messages';

const CONFIRM_TIMEOUT_MS = 10_000;
const TOAST_TIMEOUT_MS = 3_000;

const REASON_KEYS: Record<Exclude<UnrestorableReason, ''>, MessageKey> = {
  'feed-role': 'reason.feedRole',
  'no-anchor': 'reason.noAnchor',
  'anchor-not-unique': 'reason.anchorNotUnique',
  'no-fragment-support': 'reason.noFragmentSupport',
};

async function activeLocale(): Promise<Locale> {
  return resolveLocale((await store.getSettings()).locale);
}

/**
 * Only rebuilt when something in the titles actually changed, and set only after a
 * successful pass so a failure is retried rather than remembered as done.
 *
 * It covers the prefix as well as the language — a locale-only guard silently ignored every
 * prefix edit.
 */
let menuSignature: string | null = null;

/**
 * Serialised, because a burst of settings writes — typing in the prefix field fires one per
 * keystroke — would otherwise interleave two passes over the same two menu ids. The signature
 * guard then collapses the tail of a burst into no-ops, since each pass re-reads the settings
 * at the moment it actually starts.
 */
let menuQueue: Promise<unknown> = Promise.resolve();

function scheduleMenuSync(): void {
  menuQueue = menuQueue.catch(() => {}).then(syncMenus);
}

/**
 * `contextMenus.remove` / `create` wrapped in the callback form on purpose.
 *
 * `wxt/browser` is literally `globalThis.chrome` on Chrome and Edge — not a promisified
 * polyfill — so whether these return a promise at all depends on the browser version.
 * Awaiting an `undefined` return continues immediately, which is how the previous
 * `removeAll()` + `create()` pair let the creates race the removal; and `create()` reports a
 * duplicate id through `runtime.lastError` instead of throwing, so that race left the *old*
 * titles in the menu with nothing logged anywhere. The callbacks remove both guesses.
 */
function removeMenu(id: string): Promise<void> {
  return new Promise((resolve) => {
    browser.contextMenus.remove(id, () => {
      // An absent id sets lastError; reading it is what stops Chrome logging
      // "Unchecked runtime.lastError", and absent is exactly what we want anyway.
      void browser.runtime.lastError;
      resolve();
    });
  });
}

/** Resolves false when the create failed, which it reports without throwing. */
function createMenu(props: Parameters<typeof browser.contextMenus.create>[0]): Promise<boolean> {
  return new Promise((resolve) => {
    browser.contextMenus.create(props, () => {
      const error = browser.runtime.lastError;
      if (error) console.warn('[read-later] contextMenus.create failed:', error.message);
      resolve(!error);
    });
  });
}

/**
 * Points the two menu items at the current language and prefix.
 *
 * The signature is recorded only after a successful pass, so a failure is retried next time
 * instead of being remembered as done. The titles that were actually applied go into session
 * storage for the options page to display — that is what makes a stale service worker
 * visible, which is otherwise indistinguishable from the feature not working.
 */
async function syncMenus(): Promise<void> {
  const settings = await store.getSettings();
  const locale = resolveLocale(settings.locale);
  const prefix = sanitizeMenuPrefix(settings.menuPrefix);
  const signature = `${locale} ${prefix}`;
  if (menuSignature === signature) return;

  const defs = menuDefinitions(prefix, makeTranslate(locale));
  let allCreated = true;
  for (const def of defs) {
    await removeMenu(def.id);
    if (!(await createMenu({ id: def.id, title: def.title, ...def.create }))) allCreated = false;
  }

  // Neither the guard nor the reported titles may record an *intention*. `create` reports a
  // failure through `runtime.lastError` instead of throwing, so a swallowed one used to be
  // written down as done — which both suppressed the retry on the next wake and left the
  // options page showing titles that are not actually on the menu.
  if (!allCreated) return;

  menuSignature = signature;
  await store.setAppliedMenuTitles(defs.map((def) => def.title));
  console.debug('[read-later] menu titles now %o', signature);
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;

async function refreshBadge(): Promise<void> {
  if (flashTimer) {
    clearTimeout(flashTimer);
    flashTimer = undefined;
  }
  const storageError = await store.getLastStorageError();
  if (storageError) {
    await browser.action.setBadgeBackgroundColor({ color: '#d93025' });
    await browser.action.setBadgeText({ text: '!' });
    const tr = makeTranslate(await activeLocale());
    await browser.action.setTitle({ title: `Read Later — ${tr('err.storageTitle')}: ${storageError.message}` });
    return;
  }
  await browser.action.setTitle({ title: 'Read Later' });
  const settings = await store.getSettings();
  if (!settings.badgeEnabled) {
    await browser.action.setBadgeText({ text: '' });
    return;
  }
  const count = await store.unreadCount();
  await browser.action.setBadgeBackgroundColor({ color: '#5f6368' });
  await browser.action.setBadgeText({ text: count === 0 ? '' : count > 999 ? '999+' : String(count) });
}

/** Feedback of last resort, for pages we cannot inject into at all. */
async function flashBadge(text: string, color: string): Promise<void> {
  if (flashTimer) clearTimeout(flashTimer);
  await browser.action.setBadgeBackgroundColor({ color });
  await browser.action.setBadgeText({ text });
  flashTimer = setTimeout(() => {
    void refreshBadge();
  }, 1600);
}

/** Returns null when injection is impossible (restricted page) or the tab navigated away. */
async function inject<Result>(
  tabId: number,
  func: (...args: never[]) => Result | Promise<Result>,
  args: unknown[],
): Promise<Result | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: func as (...a: unknown[]) => unknown,
      args,
    });
    const first = results[0];
    if (!first) return null;
    const value = (first as { result?: unknown }).result;
    return value === undefined ? null : (value as Result);
  } catch {
    return null;
  }
}

function percentText(percent: number): string {
  return `${Math.round(percent * 100)}%`;
}

function reasonText(tr: Translate, reason: UnrestorableReason): string {
  return reason ? tr(REASON_KEYS[reason]) : '';
}

/**
 * Closes the tab a page was just saved from, including when it is the last one.
 *
 * `tabs.remove` on a window's only tab takes the window with it, and on the browser's only
 * tab it quits the browser — which would also clear the session archive (Q1). So when this
 * is the only tab left, a replacement is opened *first* and the window survives showing a
 * blank new tab. Navigating the tab to the browser's own new-tab page would work too, but
 * creating one keeps this browser-agnostic: that URL is `chrome://newtab/` on Chrome,
 * `edge://newtab/` on Edge and `about:newtab` on Firefox, and hardcoding any of them breaks
 * the rule that this code names no browser. The cost is a very short two-tab moment.
 *
 * No new permission — neither `tabs.remove` nor `tabs.query` is gated on `tabs`.
 */
async function closeSavedTab(tabId: number): Promise<void> {
  try {
    const source = await browser.tabs.get(tabId);
    const siblings = await browser.tabs.query({ windowId: source.windowId });
    if (siblings.length <= 1) {
      // Create the replacement in the source window, not whichever window happens to be
      // focused when the service worker runs.
      await browser.tabs.create({ windowId: source.windowId });
    }
  } catch (error) {
    // If the source window cannot be identified or protected, leaving the saved tab open is
    // safer than accidentally closing the whole window.
    console.warn('[read-later] could not protect source window before closing tab:', error);
    return;
  }

  await browser.tabs
    .remove(tabId)
    .catch((error: unknown) => console.warn('[read-later] tabs.remove failed:', error));
}

async function savePage(tabId: number, tabUrl: string, tabTitle: string): Promise<void> {
  // Snapshot first — the activeTab grant is tied to this tab and this gesture. A navigation or
  // redirect can make the event URL stale, so a successful snapshot is the source of truth.
  const snapshot = await inject(tabId, captureSnapshot, []);
  const pageUrl = snapshot ? snapshot.url : tabUrl;
  if (!isSavableUrl(pageUrl)) return;

  const settings = await store.getSettings();
  const tr = makeTranslate(resolveLocale(settings.locale));
  const normalized = normalizeUrl(pageUrl, await getMatcher());
  if (!normalized) return;
  const existing = await store.findItem(normalized.urlKey);

  let existingLabel = '';
  if (existing) {
    if (existing.area === 'session') existingLabel = tr('card.existingArchived');
    else if (existing.item.progress)
      existingLabel = tr('card.existingWithProgress', { percent: percentText(existing.item.progress.percent) });
    else existingLabel = tr('card.existing');
  }

  const title = snapshot ? snapshot.title || titleFromUrl(pageUrl) : tabTitle || titleFromUrl(pageUrl);
  const willClose = settings.closeTabAfterSavingPage;

  if (snapshot) {
    const metaParts: string[] = [];
    if (existingLabel) metaParts.push(existingLabel);
    metaParts.push(
      snapshot.restorable
        ? tr('card.restorable', {
            percent: snapshot.progress ? percentText(snapshot.progress.percent) : '0%',
          })
        : tr('card.notRestorable', { reason: reasonText(tr, snapshot.reason) }),
    );

    const card: ConfirmCardData = {
      heading: existing ? tr('card.updateTitle') : tr('card.saveTitle'),
      title: title || tr('card.untitled'),
      location: shortLocation(pageUrl),
      meta: metaParts.join(' · '),
      hint: snapshot.restorable ? '' : tr('card.hintUseLink'),
      cancelLabel: tr('card.cancel'),
      // The button states the whole consequence, so confirming can never close a tab the
      // card did not warn about.
      confirmLabel: existing
        ? tr(willClose ? 'card.confirmUpdateClose' : 'card.confirmUpdate')
        : tr(willClose ? 'card.confirmSaveClose' : 'card.confirmSave'),
      restorable: snapshot.restorable,
      timeoutMs: CONFIRM_TIMEOUT_MS,
    };

    const answer = await inject<boolean>(tabId, renderConfirmCard, [card, PANEL_CSS]);
    // Only an explicit `false` is a cancellation. `null` means the card could not
    // be shown at all, and blocking the save for a technical reason is worse than
    // saving without the confirmation the user already asked for by clicking.
    if (answer === false) return;
  }

  try {
    await store.upsert({
      urlKey: normalized.urlKey,
      url: pageUrl,
      title,
      progress: snapshot ? snapshot.progress : null,
    });
  } catch {
    await refreshBadge();
    return;
  }

  // Ordering matters. `refreshBadge` clears any pending flash and then rewrites the text, so
  // calling it after the flash erased the tick inside the same task — and the tick is the only
  // feedback a page that cannot be injected into ever gets, since it never sees a confirm card.
  // The flash schedules its own refresh 1600ms later, so the unread count still catches up.
  if (!snapshot) await flashBadge('✓', '#188038');
  else await refreshBadge();
  // Last, and only once the write succeeded — an early return above leaves the tab alone.
  if (willClose) await closeSavedTab(tabId);
}

async function saveLink(tabId: number | undefined, linkUrl: string): Promise<void> {
  if (!isSavableUrl(linkUrl)) return;
  const settings = await store.getSettings();
  const tr = makeTranslate(resolveLocale(settings.locale));
  const normalized = normalizeUrl(linkUrl, await getMatcher());
  if (!normalized) return;

  let title = '';
  if (tabId !== undefined) title = (await inject<string>(tabId, findLinkTitle, [linkUrl])) ?? '';
  if (!title) title = titleFromUrl(linkUrl);

  let result;
  try {
    result = await store.upsert({ urlKey: normalized.urlKey, url: linkUrl, title, progress: null });
  } catch {
    await refreshBadge();
    return;
  }
  await refreshBadge();

  const toast: ToastData = {
    headline: result.kind === 'created' ? tr('toast.saved') : tr('toast.updated'),
    sub: title,
    undoLabel: tr('toast.undo'),
    timeoutMs: TOAST_TIMEOUT_MS,
  };
  const outcome =
    tabId === undefined ? null : await inject<'undo' | 'timeout'>(tabId, renderToast, [toast, PANEL_CSS]);

  if (outcome === 'undo') {
    await store.revertUpsert(result);
    await refreshBadge();
  } else if (outcome === null) {
    await flashBadge('✓', '#188038');
  }
}

async function openItem(urlKey: string, target: OpenTarget): Promise<void> {
  const found = await store.findItem(urlKey);
  if (!found) return;
  const url = buildRestoreUrl(found.item);
  console.debug('[read-later] open-item target=%s', target);

  if (target === 'current') {
    // No tabId on purpose: `tabs.update` then means "the selected tab of the current
    // window", resolved inside the browser at call time. Querying for it here instead did
    // not work — a service worker has no window of its own, so its `currentWindow` degrades
    // to "last focused", which is exactly what is in flux while the popup closes, and the
    // empty result fell through to a new tab, which looked exactly like the setting being
    // ignored. Do not "fix" this by passing a tab id back.
    await browser.tabs.update({ url }).catch(async (error: unknown) => {
      console.warn('[read-later] could not navigate the current tab, opening a new one:', error);
      await browser.tabs.create({ url, active: true });
    });
  } else {
    await browser.tabs.create({ url, active: target === 'foreground' });
  }

  if (found.area === 'local') await store.archiveItem(urlKey);
  await refreshBadge();
}

// ---------------------------------------------------------------- subscriptions

const SUBSCRIPTION_ALARM = 'rl-subscription-update';

/**
 * One daily alarm that asks "is any list past the freshness window it declared?", rather
 * than one alarm per list on its own schedule — the check is cheap and a list's own
 * `! Expires:` decides whether anything is actually fetched.
 *
 * With auto-update off everywhere the alarm is cleared outright, so turning it off means
 * the browser never wakes us for this at all, not merely that we wake and do nothing.
 */
async function syncSubscriptionAlarm(): Promise<void> {
  const settings = await store.getSettings();
  const wanted = settings.subscriptions.some((s) => s.autoUpdate && s.enabled);
  if (!wanted) {
    await browser.alarms.clear(SUBSCRIPTION_ALARM);
    return;
  }
  // Only create when there is no alarm to keep. `create` with an existing name REPLACES it,
  // and replacing resets `delayInMinutes` — while this function runs on every worker start and
  // on every `storage.onChanged`. Recreating unconditionally therefore pushed the first fire an
  // hour into the future every time anything at all was saved, and in normal use the alarm
  // never got to fire. Replacing is idempotent in the alarm's *identity*; the property needed
  // here is idempotence in its *schedule*, which is not the same thing.
  if (await browser.alarms.get(SUBSCRIPTION_ALARM)) return;
  browser.alarms.create(SUBSCRIPTION_ALARM, { periodInMinutes: 60 * 24, delayInMinutes: 60 });
}

async function updateDueSubscriptions(): Promise<void> {
  const settings = await store.getSettings();
  const due = await dueSubscriptions(settings.subscriptions);
  for (const subscription of due) {
    const outcome = await updateSubscription(subscription);
    if (outcome.ok) {
      console.debug(
        '[read-later] updated %s: +%d -%d',
        subscription.url,
        outcome.diff.addedCount,
        outcome.diff.removedCount,
      );
    } else {
      // The previous text is kept, so this degrades to "stale", never to "no rules".
      console.warn('[read-later] could not update %s: %s', subscription.url, outcome.reason);
    }
  }
  await syncSubscriptionAlarm();
}

export default defineBackground(() => {
  // Unconditionally, on every worker start — not only on the two lifecycle events below.
  // `syncMenus` is now remove-then-create per id, which is idempotent, so this is safe (the
  // old `create`-only version was exactly what the "never at top level" rule warns about).
  // It makes the menu self-healing instead of depending on `onInstalled`/`onStartup` having
  // fired, and it means a stale or missing menu fixes itself the next time the worker wakes.
  scheduleMenuSync();
  void syncSubscriptionAlarm();

  browser.runtime.onInstalled.addListener(() => {
    scheduleMenuSync();
    void refreshBadge();
    void syncSubscriptionAlarm();
  });

  browser.runtime.onStartup.addListener(() => {
    scheduleMenuSync();
    void refreshBadge();
    // A browser that was closed for a week has lists a week out of date, and the alarm
    // that would have fired never did.
    void updateDueSubscriptions();
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SUBSCRIPTION_ALARM) void updateDueSubscriptions();
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_SAVE_LINK && info.linkUrl) {
      void saveLink(tab ? tab.id : undefined, info.linkUrl);
      return;
    }
    if (info.menuItemId === MENU_SAVE_PAGE && tab && tab.id !== undefined) {
      void savePage(tab.id, tab.url ?? info.pageUrl ?? '', tab.title ?? '');
    }
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'save-current-tab') return;
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || tab.id === undefined) return;
    await savePage(tab.id, tab.url ?? '', tab.title ?? '');
  });

  browser.runtime.onMessage.addListener((raw) => {
    const message = raw as Message;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'open-item') void openItem(message.urlKey, message.target);
    else if (message.type === 'refresh-badge') void refreshBadge();
  });

  browser.storage.onChanged.addListener(() => {
    void refreshBadge();
    // Picks up a language switch; no-ops when the locale is unchanged.
    scheduleMenuSync();
    // Picks up a subscription being added, removed, or having auto-update toggled.
    void syncSubscriptionAlarm();
  });
});
