/** Which tab an item opens in. */
export type OpenTarget =
  /** A new tab, focused. */
  | 'foreground'
  /** A new tab, left in the background so the list stays open. */
  | 'background'
  /** The tab the list was opened over, navigated in place. */
  | 'current';

/** Popup/side-panel → background. Opening an item must happen in the background:
 *  a foreground `tabs.create` closes the popup, which would kill any in-flight
 *  storage write started there. */
export type Message =
  | { type: 'open-item'; urlKey: string; target: OpenTarget }
  | { type: 'refresh-badge' };

/**
 * Resolves the three-way target from the gesture and the settings.
 *
 * Three exceptions are the whole reason this is a function rather than a ternary at the call
 * site. Ctrl/middle-click must keep adding *background* tabs whatever the setting says —
 * that is the "queue several up" gesture. The full-tab list must never navigate its own tab
 * away: there, the "current tab" is the list itself, so reusing it would throw away the
 * view, its search and its scroll position. And Alt **swaps** the default rather than only
 * moving it: with `preferCurrentTab` on, a plain click is `current` and Ctrl/middle is
 * `background`, which would leave `foreground` — "new tab, and switch to it" — with no
 * gesture at all. Negating the one flag per branch is what keeps all three reachable in
 * both settings states, which is what the test here asserts directly.
 */
export function openTargetFor(opts: {
  inBackground: boolean;
  /** Alt was held: take the other of `current` / `foreground`. */
  invert: boolean;
  /** `settings.openInCurrentTab`. */
  preferCurrentTab: boolean;
  /** True in the full-tab list, whose current tab is the list. */
  listOwnsCurrentTab: boolean;
}): OpenTarget {
  if (opts.inBackground) return 'background';
  if (opts.preferCurrentTab !== opts.invert && !opts.listOwnsCurrentTab) return 'current';
  return 'foreground';
}
