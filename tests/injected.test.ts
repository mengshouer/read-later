import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { captureSnapshot, findLinkTitle, renderConfirmCard, renderToast } from '../utils/injected';
import type { ConfirmCardData, SnapshotResult, ToastData } from '../utils/injected';
import { createFakeDom, reconstruct } from './fake-dom';
import type { FakeDom } from './fake-dom';

/**
 * These tests exist for one reason: `scripting.executeScript({ func })` serialises
 * the function and re-parses it inside the page, so a reference to anything in
 * module scope becomes a ReferenceError in production but would go unnoticed in a
 * normal unit test. `reconstruct()` rebuilds each function through `new Function`,
 * whose scope chain is the global object only — the same isolation Chrome gives.
 */

const ARTICLE_BODY =
  'A paragraph that sits above the fold and is long enough to qualify as anchor text. ' +
  'The service worker will be terminated when idle, so do not rely on module globals. ' +
  'Another later paragraph with plenty of characters in it to pass the length gate.';

function articleDom(overrides: Parameters<typeof createFakeDom>[0] = {}): FakeDom {
  return createFakeDom({
    title: 'MV3 migration guide',
    hostname: 'developer.chrome.com',
    href: 'https://developer.chrome.com/docs/mv3',
    innerHeight: 800,
    scrollY: 4000,
    scrollHeight: 12_000,
    decodedBodySize: 300_000,
    bodyText: ARTICLE_BODY,
    blocks: [
      {
        text: 'A paragraph that sits above the fold and is long enough to qualify as anchor text.',
        rect: { top: -400, bottom: -100, height: 300 },
      },
      {
        text: 'The service worker will be terminated when idle, so do not rely on module globals.',
        rect: { top: 20, bottom: 200, height: 180 },
      },
      {
        text: 'Another later paragraph with plenty of characters in it to pass the length gate.',
        rect: { top: 300, bottom: 500, height: 200 },
      },
    ],
    ...overrides,
  });
}

function snapshot(dom: FakeDom): SnapshotResult {
  return reconstruct(captureSnapshot, dom)();
}

test('captureSnapshot is self-contained and anchors on the first block below the fold', () => {
  const result = snapshot(articleDom());
  assert.equal(result.restorable, true);
  assert.equal(result.reason, '');
  assert.equal(result.title, 'MV3 migration guide');
  assert.ok(result.progress);
  assert.ok(
    result.progress.textStart.startsWith('The service worker will be'),
    `unexpected anchor: ${result.progress.textStart}`,
  );
  assert.equal(result.progress.percent, (4000 + 800) / 12_000);
  assert.equal(result.progress.docHeight, 12_000);
  assert.equal(result.progress.scrollY, 4000);
});

test('the anchor ends on a word boundary, because a text fragment that does not cannot match', () => {
  // The spec matches `textStart` with `wordStartBounded`, and — since `buildRestoreUrl` emits no
  // prefix and no suffix — `mustEndAtWordBoundary` too. A fixed 40-character slice of this
  // fixture used to produce 'The service worker will be terminated wh'; verified in Chrome, that
  // directive is ignored and the page opens at the top, while the same string cut one word
  // earlier scrolls correctly. Asserting the prefix alone cannot see the difference.
  const { progress } = snapshot(articleDom());
  assert.ok(progress);
  assert.notEqual(
    progress.textStart,
    'The service worker will be terminated wh',
    'the anchor is still cut mid-word',
  );
  assert.ok(
    /(^|\s)\S+$/.test(progress.textStart) && !/^\s|\s$/.test(progress.textStart),
    `anchor has stray whitespace: ${JSON.stringify(progress.textStart)}`,
  );
  // The word the budget landed inside is kept whole rather than dropped, so the anchor is at
  // least as long — and therefore at least as unique — as 40 characters intends.
  assert.ok(progress.textStart.length >= 40, `anchor shorter than the budget: ${progress.textStart}`);
  assert.ok(
    ARTICLE_BODY.includes(progress.textStart),
    `anchor is not a substring of the page: ${progress.textStart}`,
  );
  const nextChar = ARTICLE_BODY.charAt(
    ARTICLE_BODY.indexOf(progress.textStart) + progress.textStart.length,
  );
  assert.ok(
    nextChar === '' || /\s/.test(nextChar),
    `anchor ends mid-word, next character is ${JSON.stringify(nextChar)}`,
  );
});

test('a CJK anchor is left alone, because every position between Han characters is a boundary', () => {
  // The word-boundary adjustment must not run away to the end of the paragraph when there is no
  // whitespace to find. Verified in Chrome: a 40-character cut of this sentence does scroll.
  const zh =
    '服务工作线程在空闲时会被终止因此不要依赖模块级的全局变量这一点在迁移到第三版清单时尤其重要而且需要提前规划。';
  const { progress } = snapshot(
    articleDom({
      bodyText: zh,
      blocks: [{ text: zh, rect: { top: 20, bottom: 200, height: 180 } }],
    }),
  );
  assert.ok(progress);
  assert.equal(progress.textStart, zh.slice(0, 40));
});

test('captureSnapshot returns reason CODES, never prose — localisation happens in the background', () => {
  const result = snapshot(articleDom({ hasFeedRole: true }));
  assert.equal(result.reason, 'feed-role');
  assert.equal(result.restorable, false);
  assert.equal(result.progress, null);
});

test('captureSnapshot does not reject an ordinary article by hostname alone', () => {
  assert.equal(snapshot(articleDom({ hostname: 'news.ycombinator.com' })).reason, '');
  assert.equal(snapshot(articleDom({ hostname: 'reddit.com' })).reason, '');
});

test('a small delivered document is not evidence of a feed, however far it is scrolled', () => {
  // A content-length / delivered-bytes ratio used to reject here. It could not tell a long
  // client-rendered article from a feed, because `getEntriesByType('navigation')` describes the
  // document that was loaded, not the route on screen: measured, a 15 KB shell with 62 KB of
  // rendered text was refused at 2401px of scroll and accepted at 2400px.
  assert.equal(snapshot(articleDom({ decodedBodySize: 40, scrollY: 5000 })).reason, '');
  assert.equal(snapshot(articleDom({ decodedBodySize: 15_000, scrollY: 4000 })).reason, '');
  assert.equal(snapshot(articleDom({ decodedBodySize: 300_000, scrollY: 5000 })).reason, '');
});

test('a block whose rendered text is too short falls through to the next candidate', () => {
  // The length gate used to test `textContent` and then anchor on `innerText`. A block carrying
  // markup that does not render — a JSON-LD `<script>` inside an `article > div` is the usual
  // case — passed the check and yielded a too-short anchor, which rejected the whole page even
  // though the next candidate down was fine.
  const lead = 'Visible lead.';
  const good = 'A clean paragraph with more than enough characters to serve as the anchor here.';
  const result = snapshot(
    articleDom({
      bodyText: `${lead} ${good}`,
      blocks: [
        {
          text: lead,
          textContent: `{"@context":"https://schema.org","@type":"NewsArticle"} ${lead}`,
          rect: { top: 10, bottom: 60, height: 50 },
        },
        { text: good, rect: { top: 80, bottom: 200, height: 120 } },
      ],
    }),
  );
  assert.equal(result.reason, '');
  assert.ok(result.progress);
  assert.ok(
    good.startsWith(result.progress.textStart),
    `expected the second block, got: ${result.progress.textStart}`,
  );
});

test('captureSnapshot refuses an anchor that is not unique on the page', () => {
  const repeated = 'Repeated boilerplate sentence used twice on this page.';
  const result = snapshot(
    articleDom({
      bodyText: `${repeated} filler in between ${repeated}`,
      blocks: [{ text: repeated, rect: { top: 10, bottom: 100, height: 90 } }],
    }),
  );
  assert.equal(result.reason, 'anchor-not-unique');
});

test('captureSnapshot refuses when the viewport top has no usable text', () => {
  const result = snapshot(
    articleDom({ bodyText: 'short', blocks: [{ text: 'too short', rect: { top: 10, bottom: 40, height: 30 } }] }),
  );
  assert.equal(result.reason, 'no-anchor');
});

test('captureSnapshot bails out when the browser has no text-fragment support', () => {
  const result = snapshot(articleDom({ fragmentSupported: false }));
  assert.equal(result.reason, 'no-fragment-support');
  assert.equal(result.fragmentSupported, false);
});

test('findLinkTitle walks the whole fallback chain', () => {
  const dom = createFakeDom({
    links: [
      { href: 'https://a.com/good', text: 'WXT quickstart' },
      { href: 'https://a.com/short', text: 'x', title: 'from the title attribute' },
      { href: 'https://a.com/aria', text: '', ariaLabel: 'from aria-label' },
      { href: 'https://a.com/img', text: '', imgAlt: 'cover image caption' },
      { href: 'https://a.com/empty', text: '' },
    ],
  });
  const fn = reconstruct(findLinkTitle, dom);
  assert.equal(fn('https://a.com/good' as never), 'WXT quickstart');
  assert.equal(fn('https://a.com/short' as never), 'from the title attribute');
  assert.equal(fn('https://a.com/aria' as never), 'from aria-label');
  assert.equal(fn('https://a.com/img' as never), 'cover image caption');
  assert.equal(fn('https://a.com/empty' as never), '', 'caller falls back to titleFromUrl');
  assert.equal(fn('https://a.com/missing' as never), '');
});

test('findLinkTitle still matches when only the hash differs', () => {
  const dom = createFakeDom({ links: [{ href: 'https://a.com/p#frag', text: 'anchored link' }] });
  assert.equal(reconstruct(findLinkTitle, dom)('https://a.com/p' as never), 'anchored link');
});

const CARD: ConfirmCardData = {
  heading: 'Save for later?',
  title: 'MV3 migration guide',
  location: 'developer.chrome.com/docs/mv3',
  meta: 'Progress 40% · position restorable',
  hint: '',
  cancelLabel: 'Cancel',
  confirmLabel: 'Save',
  restorable: true,
  timeoutMs: 5000,
};

test('renderConfirmCard resolves true when the primary button is pressed', async () => {
  const dom = createFakeDom();
  const promise = reconstruct(renderConfirmCard, dom)(CARD as never, 'css' as never) as Promise<boolean>;
  const button = dom.findByText('Save');
  assert.ok(button, 'confirm button should have been created');
  assert.equal(button.attrs['data-focused'], 'true', 'focus must start on confirm so Enter alone works');
  button.fire('click');
  assert.equal(await promise, true);
});

test('renderConfirmCard resolves false on Escape', async () => {
  const dom = createFakeDom();
  const promise = reconstruct(renderConfirmCard, dom)(CARD as never, 'css' as never) as Promise<boolean>;
  dom.fireDocument('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(await promise, false);
});

test('renderConfirmCard resolves true on Enter', async () => {
  const dom = createFakeDom();
  const promise = reconstruct(renderConfirmCard, dom)(CARD as never, 'css' as never) as Promise<boolean>;
  dom.fireDocument('keydown', { key: 'Enter', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  assert.equal(await promise, true);
});

test('an unattended confirm card times out to CANCEL, never to save', async () => {
  const dom = createFakeDom();
  const promise = reconstruct(renderConfirmCard, dom)(
    { ...CARD, timeoutMs: 40 } as never,
    'css' as never,
  ) as Promise<boolean>;
  assert.equal(await promise, false);
});

test('renderConfirmCard renders whatever pre-composed strings it is handed', () => {
  const dom = createFakeDom();
  void reconstruct(renderConfirmCard, dom)(
    {
      ...CARD,
      heading: '更新这个条目？',
      meta: '此页面无法保存阅读位置（页面含 role="feed"）',
      hint: '提示：右键具体链接可直接收纳该文章',
      confirmLabel: '更新',
      restorable: false,
    } as never,
    'css' as never,
  );
  const texts = dom.created.map((element) => element.textContent);
  assert.ok(texts.includes('更新这个条目？'), texts.join(' | '));
  assert.ok(texts.includes('此页面无法保存阅读位置（页面含 role="feed"）'));
  assert.ok(texts.includes('提示：右键具体链接可直接收纳该文章'));
  assert.ok(texts.includes('更新'));
});

const TOAST: ToastData = {
  headline: 'Saved for later',
  sub: 'WXT quickstart',
  undoLabel: 'Undo',
  timeoutMs: 5000,
};

test('renderToast resolves undo when the undo button is pressed', async () => {
  const dom = createFakeDom();
  const promise = reconstruct(renderToast, dom)(TOAST as never, 'css' as never) as Promise<'undo' | 'timeout'>;
  const button = dom.findByText('Undo');
  assert.ok(button);
  button.fire('click');
  assert.equal(await promise, 'undo');
});

test('renderToast resolves timeout when ignored', async () => {
  const dom = createFakeDom();
  const promise = reconstruct(renderToast, dom)(
    { ...TOAST, timeoutMs: 40 } as never,
    'css' as never,
  ) as Promise<'undo' | 'timeout'>;
  assert.equal(await promise, 'timeout');
});

/**
 * Both panels occupy one host id, so a link-save landing on a page that already shows a confirm
 * card evicts it. Removing the node is not the whole job: the card owns a capture-phase `keydown`
 * on `document` and a promise the background is awaiting.
 */
test('a toast evicting a live confirm card cancels it and takes its key listener with it', async () => {
  const dom = createFakeDom();
  const card = reconstruct(renderConfirmCard, dom)(CARD as never, 'css' as never) as Promise<boolean>;
  const toast = reconstruct(renderToast, dom)(
    { ...TOAST, timeoutMs: 40 } as never,
    'css' as never,
  ) as Promise<'undo' | 'timeout'>;

  // No card is on screen any more, so it must not still be deciding the save. Cancel is the same
  // answer an unattended card gives; what is unacceptable is the promise staying pending.
  assert.equal(await card, false, 'the evicted card left its promise pending');

  // And the page gets its keys back. While that listener stays armed it calls preventDefault() on
  // Enter and Escape during capture, so nothing on the page can submit a form or dismiss a dialog.
  let prevented = false;
  dom.fireDocument('keydown', {
    key: 'Enter',
    shiftKey: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {},
  });
  assert.equal(prevented, false, "the evicted card's keydown listener is still on document");

  assert.equal(await toast, 'timeout');
});

test('a confirm card evicting a live toast resolves it as not-undone', async () => {
  const dom = createFakeDom();
  const toast = reconstruct(renderToast, dom)(TOAST as never, 'css' as never) as Promise<
    'undo' | 'timeout'
  >;
  const card = reconstruct(renderConfirmCard, dom)(
    { ...CARD, timeoutMs: 40 } as never,
    'css' as never,
  ) as Promise<boolean>;

  assert.equal(await toast, 'timeout', 'the evicted toast left its promise pending');
  assert.equal(await card, false);
});
