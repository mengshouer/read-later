/**
 * Functions injected via `browser.scripting.executeScript({ func })`.
 *
 * CRITICAL CONSTRAINT: each of these is serialised with `Function.prototype.toString()`
 * and re-parsed inside the page. They must therefore be entirely self-contained —
 * no imports, no module-scope helpers, no closures over anything. All input arrives
 * through `args`. Type annotations are fine (erased at build time); referencing an
 * imported *value* would produce a ReferenceError in the page.
 *
 * That constraint is also why these functions carry no user-facing text: they would
 * have no way to reach the i18n catalogue. `captureSnapshot` returns a reason *code*
 * and the renderers take fully composed strings, so localisation stays in the
 * background where it belongs and these stay dumb.
 */

/** Why a reading position cannot be restored for this page. '' means it can. */
export type UnrestorableReason =
  | ''
  | 'feed-role'
  | 'no-anchor'
  | 'anchor-not-unique'
  | 'no-fragment-support';

export interface SnapshotResult {
  title: string;
  url: string;
  /** false => reading position cannot be restored for this page; progress is null. */
  restorable: boolean;
  reason: UnrestorableReason;
  progress: {
    scrollY: number;
    docHeight: number;
    percent: number;
    textStart: string;
    textEnd?: string;
  } | null;
  /** Whether the browser supports scroll-to-text-fragment at all. */
  fragmentSupported: boolean;
}

/** Every string is pre-composed and pre-localised by the caller. */
export interface ConfirmCardData {
  heading: string;
  title: string;
  location: string;
  meta: string;
  hint: string;
  cancelLabel: string;
  confirmLabel: string;
  /** Styling only — drives the warning colour on the meta line. */
  restorable: boolean;
  timeoutMs: number;
}

export interface ToastData {
  headline: string;
  sub: string;
  undoLabel: string;
  timeoutMs: number;
}

/**
 * One-shot reading-position snapshot plus a best-effort verdict. Only a page that declares
 * `role="feed"` is rejected as a feed; a hostname is never proof, and neither is any
 * single-snapshot guess at whether content grows as you scroll.
 */
export function captureSnapshot(): SnapshotResult {
  var doc = document;
  var scroller = (doc.scrollingElement || doc.documentElement) as HTMLElement;
  var viewport = window.innerHeight || scroller.clientHeight || 0;
  var scrollY = window.scrollY || scroller.scrollTop || 0;
  var docHeight = scroller.scrollHeight || 1;
  var percent = Math.max(0, Math.min(1, (scrollY + viewport) / docHeight));
  var fragmentSupported =
    typeof (doc as unknown as { fragmentDirective?: unknown }).fragmentDirective !== 'undefined';
  var pageTitle = doc.title || '';
  var pageUrl = location.href;

  function squash(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  /** Stops counting at 2 — we only ever ask "is this unique?". */
  function occurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    var count = 0;
    var cursor = 0;
    for (;;) {
      var at = haystack.indexOf(needle, cursor);
      if (at < 0) break;
      count++;
      if (count > 1) break;
      cursor = at + needle.length;
    }
    return count;
  }

  /**
   * Letters and digits from the scripts that separate words with spaces (Latin and its
   * extensions, Greek, Cyrillic). Deliberately excludes CJK: every position between two Han
   * characters already is a word boundary, so those slices need no adjustment.
   */
  function isWordChar(value: string, at: number): boolean {
    var ch = value.charAt(at);
    return ch !== '' && /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(ch);
  }

  /**
   * Text fragments match on word boundaries. The spec runs `find a string in range` with
   * `wordStartBounded`, and because `buildRestoreUrl` emits neither a prefix nor a suffix,
   * `mustEndAtWordBoundary` is true as well — so a slice ending mid-word never matches and the
   * directive is silently ignored, leaving the page at the top. Verified in Chrome: the whole
   * sentence and a word-bounded prefix both scroll, `…terminated wh` does not.
   *
   * Extending to the next boundary rather than backing off to the previous one keeps the anchor
   * at least as long, and therefore at least as unique, as the character budget intends.
   */
  function sliceToWordEnd(value: string, at: number): string {
    if (at >= value.length) return value;
    var cut = at;
    while (cut < value.length && isWordChar(value, cut) && isWordChar(value, cut - 1)) cut++;
    return value.slice(0, cut);
  }

  /** The mirror of `sliceToWordEnd` for `textEnd`, which is matched `wordStartBounded`. */
  function sliceToWordStart(value: string, from: number): string {
    if (from <= 0) return value;
    var cut = from;
    while (cut > 0 && isWordChar(value, cut) && isWordChar(value, cut - 1)) cut--;
    return value.slice(cut);
  }

  function reject(reason: UnrestorableReason): SnapshotResult {
    return {
      title: pageTitle,
      url: pageUrl,
      restorable: false,
      reason: reason,
      progress: null,
      fragmentSupported: fragmentSupported,
    };
  }

  if (!fragmentSupported) return reject('no-fragment-support');

  // ---- feed detection ------------------------------------------------------
  // The semantic signal only. A content-length / delivered-bytes ratio used to reject here too,
  // but `performance.getEntriesByType('navigation')` describes the document that was *loaded*:
  // on a client-rendered or client-routed page it reports the shell while `body.innerText`
  // reports the finished route, so the ratio was structurally inflated. Measured: a 15 KB shell
  // with 62 KB of rendered text tripped it at 2401px of scroll and passed at 2400px — an
  // ordinary documentation page lost its position for reading three screens in. And what
  // actually defines a feed, content being *appended as you scroll*, cannot be observed in a
  // single snapshot at all, so the signal was never measuring the thing it was named after.
  if (doc.querySelector('[role="feed"]')) return reject('feed-role');

  var bodyText = doc.body ? doc.body.innerText || '' : '';

  // ---- anchor at the top of what you are looking at ------------------------
  var nodes = doc.querySelectorAll(
    'p,li,h1,h2,h3,h4,h5,blockquote,pre,td,dd,figcaption,section>div,article>div',
  );
  var limit = nodes.length < 3000 ? nodes.length : 3000;
  var chosen = '';
  var straddlingText = '';

  for (var i = 0; i < limit; i++) {
    var el = nodes[i] as HTMLElement;
    // Cheap pre-filter; the real gate is on the rendered text below.
    if ((el.textContent || '').trim().length < 30) continue;
    var rect = el.getBoundingClientRect();
    if (rect.height === 0) continue;
    if (rect.bottom <= 0 || rect.top >= viewport) continue;
    // The length gate has to be on the text actually used as the anchor. Testing `textContent`
    // and then anchoring on `innerText` let a block whose markup carries text that does not
    // render — a JSON-LD `<script>` inside an `article > div` is the common case — pass the
    // check and then yield a too-short anchor, which rejected the entire page even when the
    // next candidate down was a perfectly good one.
    var text = squash(el.innerText || el.textContent || '');
    if (text.length < 30) continue;
    if (rect.top >= 0) {
      chosen = text;
      break;
    }
    if (!straddlingText) straddlingText = text;
  }

  if (!chosen) chosen = straddlingText;
  if (!chosen) return reject('no-anchor');

  var haystack = squash(bodyText);
  var textStart = sliceToWordEnd(chosen, 40);
  if (occurrences(haystack, textStart) !== 1 && chosen.length > textStart.length) {
    textStart = sliceToWordEnd(chosen, 80);
  }

  var textEnd: string | undefined;
  if (occurrences(haystack, textStart) !== 1) {
    if (chosen.length <= 120) return reject('anchor-not-unique');
    textEnd = sliceToWordStart(chosen, chosen.length - 40);
    if (occurrences(haystack, chosen) !== 1) return reject('anchor-not-unique');
  }

  return {
    title: pageTitle,
    url: pageUrl,
    restorable: true,
    reason: '',
    progress: {
      scrollY: scrollY,
      docHeight: docHeight,
      percent: percent,
      textStart: textStart,
      textEnd: textEnd,
    },
    fragmentSupported: fragmentSupported,
  };
}

/**
 * `OnClickData` carries `linkUrl` but no anchor text, and a persistent content
 * script (which could record the contextmenu target) would cost `<all_urls>`.
 * So resolve the anchor by href at click time instead, then walk a fallback chain.
 */
export function findLinkTitle(linkUrl: string): string {
  function squash(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }
  function clip(value: string): string {
    return value.length > 300 ? value.slice(0, 300) : value;
  }

  var links = document.links;
  var anchor: HTMLAnchorElement | null = null;
  for (var i = 0; i < links.length; i++) {
    if ((links[i] as HTMLAnchorElement).href === linkUrl) {
      anchor = links[i] as HTMLAnchorElement;
      break;
    }
  }
  if (!anchor) {
    var bare = linkUrl.split('#')[0];
    for (var j = 0; j < links.length; j++) {
      if ((links[j] as HTMLAnchorElement).href.split('#')[0] === bare) {
        anchor = links[j] as HTMLAnchorElement;
        break;
      }
    }
  }
  if (!anchor) return '';

  var text = squash(anchor.innerText || anchor.textContent || '');
  if (text.length > 2) return clip(text);
  var titleAttr = squash(anchor.getAttribute('title') || '');
  if (titleAttr.length > 2) return clip(titleAttr);
  var aria = squash(anchor.getAttribute('aria-label') || '');
  if (aria.length > 2) return clip(aria);
  var img = anchor.querySelector('img');
  var alt = img ? squash(img.getAttribute('alt') || '') : '';
  if (alt.length > 2) return clip(alt);
  return '';
}

const PANEL_CSS = `
:host { all: initial; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  width: 320px; box-sizing: border-box;
  font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #1a1a1a; background: #fff;
  border: 1px solid rgba(0,0,0,.1); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.18);
  padding: 12px 14px; animation: rise .14s ease-out;
}
@keyframes rise { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.head { font-weight: 600; margin-bottom: 6px; }
.title {
  font-weight: 500; margin-bottom: 2px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.loc { color: #666; font-size: 12px; word-break: break-all; margin-bottom: 6px; }
.meta { font-size: 12px; color: #444; margin-bottom: 10px; }
.warn { color: #a04a00; }
.hint { font-size: 11px; color: #777; margin: -4px 0 10px; }
.row { display: flex; gap: 8px; justify-content: flex-end; }
button {
  font: inherit; padding: 5px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(0,0,0,.15); background: #f5f5f5; color: inherit;
}
button.primary { background: #2f6feb; border-color: #2f6feb; color: #fff; font-weight: 500; }
button:focus-visible { outline: 2px solid #2f6feb; outline-offset: 2px; }
.bar { height: 2px; background: #2f6feb; opacity: .35; margin-top: 10px; border-radius: 2px; }
@media (prefers-color-scheme: dark) {
  .wrap { color: #eaeaea; background: #232323; border-color: rgba(255,255,255,.12); }
  .loc { color: #9a9a9a } .meta { color: #c4c4c4 } .hint { color: #8a8a8a }
  .warn { color: #f0a35e }
  button { background: #333; border-color: rgba(255,255,255,.16) }
  button.primary { background: #3b7bf5; border-color: #3b7bf5; color: #fff }
}
`;

/**
 * Both panels below share one `HOST_ID`, so either can be asked to replace the other. The host
 * element is the only thing they can share: each is serialised by `Function.prototype.toString()`
 * and re-parsed in the page, with no access to this module's scope. So the pending panel's
 * teardown rides on its own DOM node, and whoever evicts it runs that first.
 *
 * Removing the node alone is not enough. The confirm card has a capture-phase `keydown` on
 * `document` that calls `preventDefault()` on Enter and Escape, and a promise the background is
 * still awaiting — detaching the node leaves both live, so the page swallows those two keys and
 * the save is eventually resolved as *cancelled* with no card on screen to explain it.
 */
type PanelHost = HTMLElement & { rlTeardown?: () => void };

/**
 * The confirm card. Non-modal, bottom-right, focus pre-placed on the confirm button so that
 * whatever key the user bound to saving, the gesture finishes with one more press of `Enter`.
 * Times out to *cancel*, never to confirm — an unattended card must not save silently.
 */
export function renderConfirmCard(data: ConfirmCardData, css: string): Promise<boolean> {
  var HOST_ID = '__read_later_panel__';
  var existing = document.getElementById(HOST_ID) as PanelHost | null;
  if (existing) {
    if (existing.rlTeardown) existing.rlTeardown();
    existing.remove();
  }

  var host = document.createElement('div') as PanelHost;
  host.id = HOST_ID;
  var root = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'wrap';

  var head = document.createElement('div');
  head.className = 'head';
  head.textContent = data.heading;
  wrap.appendChild(head);

  var title = document.createElement('div');
  title.className = 'title';
  title.textContent = data.title;
  wrap.appendChild(title);

  var loc = document.createElement('div');
  loc.className = 'loc';
  loc.textContent = data.location;
  wrap.appendChild(loc);

  var meta = document.createElement('div');
  meta.className = 'meta' + (data.restorable ? '' : ' warn');
  meta.textContent = data.meta;
  wrap.appendChild(meta);

  if (data.hint) {
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = data.hint;
    wrap.appendChild(hint);
  }

  var row = document.createElement('div');
  row.className = 'row';
  var cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = data.cancelLabel;
  var confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'primary';
  confirm.textContent = data.confirmLabel;
  row.appendChild(cancel);
  row.appendChild(confirm);
  wrap.appendChild(row);

  var bar = document.createElement('div');
  bar.className = 'bar';
  wrap.appendChild(bar);

  root.appendChild(wrap);
  document.documentElement.appendChild(host);
  confirm.focus();

  return new Promise<boolean>(function (resolve) {
    var done = false;
    var timer = 0;

    function finish(value: boolean) {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      // `tick` is `var`-hoisted and always assigned by the time any of these paths can run:
      // nothing dispatches an event between its assignment and the listeners above it.
      window.clearInterval(tick);
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(value);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
    }

    cancel.addEventListener('click', function () {
      finish(false);
    });
    confirm.addEventListener('click', function () {
      finish(true);
    });
    document.addEventListener('keydown', onKey, true);
    // Evicted by the toast (or by a second card) rather than answered: cancel, which is the same
    // answer an unattended card gives. Without this the listener and the promise outlive the node.
    host.rlTeardown = function () {
      finish(false);
    };

    var started = Date.now();
    var total = data.timeoutMs;
    var tick = window.setInterval(function () {
      var left = Math.max(0, 1 - (Date.now() - started) / total);
      bar.style.transform = 'scaleX(' + left + ')';
      bar.style.transformOrigin = 'left';
      if (left === 0) window.clearInterval(tick);
    }, 100);

    timer = window.setTimeout(function () {
      window.clearInterval(tick);
      finish(false);
    }, total);
  });
}

/** Feedback for the link-save path, which is deliberately unconfirmed, with undo. */
export function renderToast(data: ToastData, css: string): Promise<'undo' | 'timeout'> {
  var HOST_ID = '__read_later_panel__';
  var existing = document.getElementById(HOST_ID) as PanelHost | null;
  if (existing) {
    if (existing.rlTeardown) existing.rlTeardown();
    existing.remove();
  }

  var host = document.createElement('div') as PanelHost;
  host.id = HOST_ID;
  var root = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'wrap';

  var head = document.createElement('div');
  head.className = 'head';
  head.textContent = data.headline;
  wrap.appendChild(head);

  var sub = document.createElement('div');
  sub.className = 'title';
  sub.textContent = data.sub;
  wrap.appendChild(sub);

  var row = document.createElement('div');
  row.className = 'row';
  var undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = data.undoLabel;
  row.appendChild(undo);
  wrap.appendChild(row);

  var bar = document.createElement('div');
  bar.className = 'bar';
  wrap.appendChild(bar);

  root.appendChild(wrap);
  document.documentElement.appendChild(host);

  return new Promise<'undo' | 'timeout'>(function (resolve) {
    var done = false;
    function finish(value: 'undo' | 'timeout') {
      if (done) return;
      done = true;
      window.clearInterval(tick);
      host.remove();
      resolve(value);
    }
    undo.addEventListener('click', function () {
      finish('undo');
    });
    // Evicted by a card or another toast: the same answer as being ignored, which is what the
    // caller treats as "not undone". Resolving here rather than leaving the promise to expire.
    host.rlTeardown = function () {
      finish('timeout');
    };
    var started = Date.now();
    var tick = window.setInterval(function () {
      var left = Math.max(0, 1 - (Date.now() - started) / data.timeoutMs);
      bar.style.transform = 'scaleX(' + left + ')';
      bar.style.transformOrigin = 'left';
      if (left === 0) window.clearInterval(tick);
    }, 100);
    window.setTimeout(function () {
      window.clearInterval(tick);
      finish('timeout');
    }, data.timeoutMs);
  });
}

export { PANEL_CSS };
