import type { Translate } from './i18n';

/**
 * The user-editable prefix on the two context menu items.
 *
 * It exists for one reason: position in the right-click menu. Chrome sorts an extension's
 * entry by a title that depends on how many of its items match the current context —
 * `ContextMenuMatcher::GetTopLevelContextMenuTitle` uses the *extension name* when two or
 * more are visible at once, and the *item's own title* when exactly one is. Our page and
 * link items are mutually exclusive by construction, so we always land in the single-item
 * branch, which makes the item title the sort key and therefore something a user can steer.
 *
 * Handing the lever over rather than picking a clever default is also the honest move: we
 * could not confirm the surrounding sort call site in the current Chromium tree, and Edge
 * may well differ. So this doubles as the cheapest possible experiment — type a character,
 * reload, see whether the entry moves. If it does not, that browser sorts by extension name
 * and no title can help.
 */

/** Long enough for a sort prefix, short enough to leave the real label readable. */
export const MENU_PREFIX_MAX = 16;

/**
 * How long a mismatch between the settings and the applied menu titles has to last before the
 * options page is willing to call it a problem.
 *
 * A mismatch is the *normal* state for one round trip: the settings write, `storage.onChanged`
 * waking the service worker if it was asleep, `syncMenus` re-reading the settings and doing two
 * remove/create pairs, the applied titles going back into session storage, and the options page
 * re-reading them. Waking a sleeping worker is the slow part and the only one measured in
 * hundreds of milliseconds — hence seconds rather than milliseconds of slack.
 */
export const MENU_SYNC_GRACE_MS = 2000;

/**
 * `%s` in a `contextMenus` title is replaced by the selected text, so a prefix containing it
 * would splice the selection into the label. Dropped rather than escaped, because the API
 * defines no escape for it. Whitespace is collapsed so the prefix cannot pad the label out.
 */
export function sanitizeMenuPrefix(raw: string): string {
  return raw
    .replace(/%s/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MENU_PREFIX_MAX)
    .trim();
}

/** Always joined by exactly one space, so what you type is what you get. */
export function menuTitle(prefix: string, title: string): string {
  const clean = sanitizeMenuPrefix(prefix);
  return clean ? `${clean} ${title}` : title;
}

/** One context menu item, ready for `contextMenus.create`. */
export interface MenuDef {
  id: string;
  title: string;
  create: {
    contexts: ['page'] | ['link'];
    documentUrlPatterns?: string[];
    targetUrlPatterns?: string[];
  };
}

export const MENU_SAVE_PAGE = 'rl-save-page';
export const MENU_SAVE_LINK = 'rl-save-link';

const HTTP_ONLY = ['http://*/*', 'https://*/*'];

/**
 * The two items the extension registers, titled for the given locale and prefix.
 *
 * Lives here rather than in the background so the settings-to-title composition is
 * testable — the background layer has no test harness, and `contextMenus` is one of the
 * APIs `fakeBrowser` leaves unimplemented.
 *
 * The two are naturally mutually exclusive: the `page` context only applies when no other
 * page context does, so right-clicking a link shows only the link item. No hit-testing of
 * our own is needed (D7).
 */
export function menuDefinitions(prefix: string, tr: Translate): MenuDef[] {
  return [
    {
      id: MENU_SAVE_PAGE,
      title: menuTitle(prefix, tr('menu.savePage')),
      create: { contexts: ['page'], documentUrlPatterns: [...HTTP_ONLY] },
    },
    {
      id: MENU_SAVE_LINK,
      title: menuTitle(prefix, tr('menu.saveLink')),
      create: { contexts: ['link'], targetUrlPatterns: [...HTTP_ONLY] },
    },
  ];
}
