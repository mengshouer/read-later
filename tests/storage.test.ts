import { strict as assert } from 'node:assert';
import { beforeEach, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import * as store from '../utils/storage';
import { compileFilters } from '../utils/filters';
import type { Progress } from '../utils/types';

beforeEach(() => {
  fakeBrowser.reset();
});

/** Filters are a parameter now, not something storage reads for itself. */
const compile = (text = '') => compileFilters([{ id: 'test', text }]);

const progress = (percent: number, textStart = 'anchor text here'): Progress => ({
  scrollY: Math.round(percent * 10_000),
  docHeight: 10_000,
  percent,
  textStart,
});

const draft = (urlKey: string, url: string, title: string, p: Progress | null = null) => ({
  urlKey,
  url,
  title,
  progress: p,
});

test('a first save creates an unread item', async () => {
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.4)));
  assert.equal(result.kind, 'created');
  assert.equal(result.previous, null);
  assert.equal(result.item.status, 'unread');
  assert.equal(result.item.progress?.percent, 0.4);

  const unread = await store.listUnread();
  assert.equal(unread.length, 1);
  assert.equal(unread[0]?.urlKey, 'e.com/a');
});

test('re-saving keeps addedAt, moves updatedAt, and overwrites progress', async () => {
  const first = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.4)));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.72)));

  assert.equal(second.kind, 'updated');
  assert.equal(second.item.addedAt, first.item.addedAt, 'addedAt must stay put so sort order is stable');
  assert.ok(second.item.updatedAt > first.item.updatedAt);
  assert.equal(second.item.progress?.percent, 0.72);
  assert.equal(second.oldPercent, 0.4);
  assert.equal(second.progressChanged, true);
  assert.equal((await store.listUnread()).length, 1, 'still one item — this is the dedup');
});

test('a near-zero snapshot does not clobber a real prior position', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.45)));
  // Simulates a failed text-fragment landing at page top and reporting ~0%.
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.01)));
  assert.equal(result.item.progress?.percent, 0.45);
  assert.equal(result.progressChanged, false);
});

test('an explicit scroll back to the start does overwrite (above the 5% guard)', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.45)));
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.08)));
  assert.equal(result.item.progress?.percent, 0.08);
});

test('saving a link over an existing item keeps the progress it already had', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.5)));
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', null));
  assert.equal(result.item.progress?.percent, 0.5);
});


test('re-saving the same PDF identity updates its latest page URL', async () => {
  const urlKey = 'https://example.com/book.pdf';
  await store.upsert(draft(urlKey, 'https://example.com/book.pdf#page=3', 'Book'));
  await store.upsert(draft(urlKey, 'https://example.com/book.pdf#page=9', 'Book'));

  const unread = await store.listUnread();
  assert.equal(unread.length, 1);
  assert.equal(unread[0]?.url, 'https://example.com/book.pdf#page=9');
});

test('re-saving an archived item revives it to unread and empties the archive', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.45)));
  await store.archiveItem('e.com/a');
  assert.equal((await store.listUnread()).length, 0);
  assert.equal((await store.listArchived()).length, 1);

  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.72)));
  assert.equal(result.kind, 'updated');
  assert.equal(result.previousArea, 'session');
  assert.equal(result.item.status, 'unread');
  assert.equal((await store.listUnread()).length, 1);
  assert.equal((await store.listArchived()).length, 0, 'must not exist in both places at once');
});


test('reviving an archived item keeps the archive when the local write fails', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.45)));
  await store.archiveItem('e.com/a');
  vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota exceeded'));

  await assert.rejects(() =>
    store.upsert(draft('e.com/a', 'https://e.com/a', 'A again', progress(0.72))),
  );
  vi.restoreAllMocks();

  assert.equal((await store.findItem('e.com/a'))?.area, 'session');
  assert.equal((await store.listArchived())[0]?.progress?.percent, 0.45);
});

test('a manually edited title survives later saves', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'Auto title'));
  await store.renameItem('e.com/a', '我改的标题');
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'Auto title again'));
  assert.equal(result.item.title, '我改的标题');
});

test('undo removes a freshly created item', async () => {
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.revertUpsert(result);
  assert.equal((await store.listUnread()).length, 0);
});

test('undo restores an updated item to its previous area and progress', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.45)));
  await store.archiveItem('e.com/a');
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.9)));

  await store.revertUpsert(result);
  assert.equal((await store.listUnread()).length, 0);
  const archived = await store.listArchived();
  assert.equal(archived.length, 1);
  assert.equal(archived[0]?.progress?.percent, 0.45);
});


test('undo keeps the current unread copy when restoring its archived predecessor fails', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.45)));
  await store.archiveItem('e.com/a');
  const result = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.9)));
  vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('session quota exceeded'));

  await assert.rejects(() => store.revertUpsert(result));
  vi.restoreAllMocks();

  assert.equal((await store.findItem('e.com/a'))?.area, 'local');
  assert.equal((await store.listUnread())[0]?.progress?.percent, 0.9);
});

/**
 * The undo window is a few seconds wide and the toast lives on the page while the list lives in
 * the popup, so a second action on the same URL in between is reachable. `updatedAt` is the stamp
 * that tells a stale undo apart from a live one; the clock is pinned here so the two saves cannot
 * land in the same millisecond and make the test depend on timing.
 */
test('a stale undo leaves a newer save alone instead of deleting it', async () => {
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(1_000);
  const first = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.2)));
  clock.mockReturnValue(2_000);
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.8)));
  vi.restoreAllMocks();

  await store.revertUpsert(first);

  const unread = await store.listUnread();
  assert.equal(unread.length, 1, 'a stale undo deleted the save that replaced it');
  assert.equal(unread[0]?.progress?.percent, 0.8);
});

test('a stale undo does not put an unread copy back beside the archived one', async () => {
  const clock = vi.spyOn(Date, 'now');
  clock.mockReturnValue(1_000);
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.2)));
  clock.mockReturnValue(2_000);
  const second = await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.8)));
  vi.restoreAllMocks();

  // Opening the item archives it: local -> session. `second.previousArea` is 'local', so undo
  // used to write an unread copy back without touching the archive, leaving one URL in both.
  await store.archiveItem('e.com/a');
  await store.revertUpsert(second);

  assert.equal((await store.listUnread()).length, 0, 'the same URL is now in both lists');
  assert.equal((await store.listArchived()).length, 1);
});

test('archive and restore move the item between areas without duplicating it', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.archiveItem('e.com/a');
  assert.equal((await store.findItem('e.com/a'))?.area, 'session');
  await store.restoreItem('e.com/a');
  assert.equal((await store.findItem('e.com/a'))?.area, 'local');
  assert.equal((await store.listArchived()).length, 0);
});

test('delete removes the item from both areas', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.upsert(draft('e.com/b', 'https://e.com/b', 'B'));
  await store.archiveItem('e.com/b');
  await store.deleteItems(['e.com/a', 'e.com/b']);
  assert.equal((await store.listUnread()).length, 0);
  assert.equal((await store.listArchived()).length, 0);
});

test('settings round-trip and fall back to defaults for unknown keys', async () => {
  const initial = await store.getSettings();
  assert.equal(initial.sortDir, 'asc', 'oldest-first default');
  await store.patchSettings({ sortDir: 'desc', badgeEnabled: false });
  const next = await store.getSettings();
  assert.equal(next.sortDir, 'desc');
  assert.equal(next.badgeEnabled, false);
  assert.equal(next.groupByDomain, true, 'untouched keys keep their default');
});

test('row actions stay off by default, including for settings saved before the toggle existed', async () => {
  assert.equal((await store.getSettings()).rowActionsEnabled, false, 'a fresh install shows no row buttons');
  assert.equal((await store.getSettings()).openInCurrentTab, false, 'and never replaces the tab unasked');
  assert.equal((await store.getSettings()).closeTabAfterSavingPage, false, 'nor closes one unasked');
  assert.equal((await store.getSettings()).menuPrefix, '', 'and adds nothing to the menu labels');

  // A profile whose stored settings predate both fields entirely.
  await fakeBrowser.storage.local.set({ settings: { sortDir: 'desc', filterText: '$removeparam=fbclid' } });
  const migrated = await store.getSettings();
  assert.equal(migrated.rowActionsEnabled, false, 'an existing user does not suddenly grow buttons');
  assert.equal(migrated.openInCurrentTab, false, 'nor start losing the page they were reading');
  assert.equal(migrated.closeTabAfterSavingPage, false, 'nor start closing tabs on them');
  assert.equal(migrated.sortDir, 'desc', 'and their own choices survive the merge');
  assert.deepEqual(migrated.subscriptions, [], 'and subscribe to nothing on their behalf');

  await store.patchSettings({ rowActionsEnabled: true, openInCurrentTab: true });
  const opted = await store.getSettings();
  assert.equal(opted.rowActionsEnabled, true);
  assert.equal(opted.openInCurrentTab, true);
  assert.equal(opted.filterText, '$removeparam=fbclid', 'the patch is a merge, not a replace');
});

test('a recompute is previewed before it runs, and names what it would destroy', async () => {
  // Two URLs that differ only by a param the default (empty) filter set keeps.
  await store.upsert(draft('https://forum.example/t?p=1', 'https://forum.example/t?p=1', 'One', progress(0.2)));
  // `mergeItems` keeps the newer item's URL, so the two need distinct timestamps for the
  // survivor to be the one this test names rather than a tie-break on insertion order.
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.upsert(draft('https://forum.example/t?p=2', 'https://forum.example/t?p=2', 'Two', progress(0.8)));
  assert.equal((await store.listUnread()).length, 2);

  const filters = compile('||forum.example^$removeparam');
  const plan = await store.planRecompute(filters);
  assert.equal(plan.rekeyed, 2);
  assert.equal(plan.merged, 1);
  // The point of the preview: a merge discards one URL for good, so it has to be named
  // BEFORE anything is written. No switch and no unsubscribe brings it back afterwards.
  assert.equal(plan.losing.length, 1);
  assert.equal(plan.losing[0]?.url, 'https://forum.example/t?p=1');
  assert.equal(plan.losing[0]?.intoUrl, 'https://forum.example/t?p=2');
  assert.equal((await store.listUnread()).length, 2, 'and the preview wrote nothing');
});

test('recomputeAllKeys re-keys and merges after a filter change', async () => {
  await store.upsert(draft('https://forum.example/t?p=1', 'https://forum.example/t?p=1', 'One', progress(0.2)));
  await store.upsert(draft('https://forum.example/t?p=2', 'https://forum.example/t?p=2', 'Two', progress(0.8)));

  const report = await store.recomputeAllKeys(compile('||forum.example^$removeparam'));

  if (!report.ok) assert.fail('an unguarded recompute always writes');
  assert.equal(report.rekeyed, 2);
  assert.equal(report.merged, 1);
  const remaining = await store.listUnread();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.urlKey, 'https://forum.example/t');
  assert.equal(remaining[0]?.progress?.percent, 0.8, 'merge keeps the furthest progress');
});

test('recomputeAllKeys is a no-op when the filters did not change', async () => {
  await store.upsert(draft('https://example.com/a', 'https://example.com/a', 'A'));
  const report = await store.recomputeAllKeys(compile());
  if (!report.ok) assert.fail('nothing was going to be discarded');
  assert.equal(report.rekeyed, 0);
  assert.equal(report.merged, 0);
  assert.equal((await store.listUnread()).length, 1);
});


test('recomputeAllKeys also re-keys archived items', async () => {
  await store.upsert(draft('https://forum.example/t?p=1', 'https://forum.example/t?p=1', 'Archived'));
  await store.archiveItem('https://forum.example/t?p=1');

  const filters = compile('||forum.example^$removeparam');
  assert.equal((await store.planRecompute(filters)).rekeyed, 1);
  const report = await store.recomputeAllKeys(filters);
  if (!report.ok) assert.fail('an unguarded recompute always writes');

  assert.equal((await store.findItem('https://forum.example/t'))?.area, 'session');
  assert.equal(await store.findItem('https://forum.example/t?p=1'), null);
});

test('a cross-area rekey collision keeps unread status and the best progress', async () => {
  await store.upsert(draft('https://forum.example/t?p=1', 'https://forum.example/t?p=1', 'Archived', progress(0.9)));
  await store.archiveItem('https://forum.example/t?p=1');
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.upsert(draft('https://forum.example/t?p=2', 'https://forum.example/t?p=2', 'Unread', progress(0.2)));

  const filters = compile('||forum.example^$removeparam');
  const plan = await store.planRecompute(filters);
  assert.equal(plan.merged, 1);
  assert.equal(plan.losing.length, 1, 'the discarded distinct URL is named before the merge');
  const report = await store.recomputeAllKeys(
    filters,
    plan.losing.map((entry) => entry.url),
  );
  if (!report.ok) assert.fail('the confirmed cross-area merge must write');

  const unread = await store.listUnread();
  assert.equal(unread.length, 1);
  assert.equal(unread[0]?.progress?.percent, 0.9);
  assert.equal((await store.listArchived()).length, 0);
});

test('a confirmed recompute refuses to discard a URL the preview never named', async () => {
  // The preview is the whole safety mechanism for the one irreversible step in the feature, and
  // it was computed from a snapshot of items AND filters that neither side froze. Anything that
  // moves in between — a subscription auto-updating, another window saving a page — used to be
  // written without ever being shown.
  await store.upsert(draft('https://forum.example/t?p=1', 'https://forum.example/t?p=1', 'One'));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.upsert(draft('https://forum.example/t?p=2', 'https://forum.example/t?p=2', 'Two'));

  const filters = compile('||forum.example^$removeparam');
  const plan = await store.planRecompute(filters);
  const named = plan.losing.map((entry) => entry.url);
  assert.deepEqual(named, ['https://forum.example/t?p=1']);

  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.upsert(draft('https://forum.example/t?p=3', 'https://forum.example/t?p=3', 'Three'));

  const refused = await store.recomputeAllKeys(filters, named);
  if (refused.ok) assert.fail('the write must be refused once an unnamed URL would be lost');
  assert.deepEqual(
    refused.unnamed.map((entry) => entry.url),
    ['https://forum.example/t?p=2'],
  );
  assert.equal((await store.listUnread()).length, 3, 'and nothing was written');

  // Re-planning is the way out: the same call with the fresh plan goes through.
  const fresh = await store.planRecompute(filters);
  const done = await store.recomputeAllKeys(
    filters,
    fresh.losing.map((entry) => entry.url),
  );
  if (!done.ok) assert.fail('the re-planned confirmation must go through');
  assert.equal(done.merged, 2);
  assert.equal((await store.listUnread()).length, 1);
});

test('a merge of two items that share a URL names nobody as lost', async () => {
  // Same verbatim `url` under two keys happens when they were normalised against different
  // filters at different times. The merge is real, but no URL stops existing, and the preview
  // used to name the survivor as its own casualty.
  await store.upsert(draft('https://example.com/a?x=1', 'https://example.com/a?x=1', 'A'));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await store.upsert(draft('https://example.com/a', 'https://example.com/a?x=1', 'A again'));

  const plan = await store.planRecompute(compile('||example.com^$removeparam'));
  assert.equal(plan.merged, 1);
  assert.deepEqual(plan.losing, []);
});

test('export then import round-trips the unread list', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.3)));
  await store.upsert(draft('e.com/b', 'https://e.com/b', 'B'));
  const payload = await store.exportAll();
  assert.equal(payload.format, 'read-later');
  assert.equal(payload.items.length, 2);

  await store.clearAllItems();
  assert.equal((await store.listUnread()).length, 0);

  const report = await store.importPayload(payload, compile());
  assert.equal(report.created, 2);
  assert.equal(report.merged, 0);
  assert.equal((await store.listUnread()).length, 2);
});


test('new exports contain unread items only, not settings', async () => {
  await store.patchSettings({ sortDir: 'desc' });
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  const payload = await store.exportAll();
  assert.equal('settings' in payload, false);
});

test('import ignores settings from an older backup', async () => {
  await store.importPayload(
    { items: [], settings: { sortDir: 'desc', badgeEnabled: false } },
    compile(),
  );
  assert.equal((await store.getSettings()).sortDir, 'asc');
  assert.equal((await store.getSettings()).badgeEnabled, true);
});

test('import sanitizes optional fields instead of discarding a valid URL', async () => {
  const report = await store.importPayload(
    {
      items: [
        {
          url: 'https://example.com/posts/read-me.html',
          title: '   ',
          addedAt: -1,
          updatedAt: Number.MAX_VALUE,
          progress: { scrollY: 50, docHeight: 100, percent: 2, textStart: 'anchor' },
        },
      ],
    },
    compile(),
  );
  assert.deepEqual(report, { created: 1, merged: 0, skipped: 0 });
  const item = (await store.listUnread())[0];
  assert.equal(item?.title, 'read me');
  assert.equal(item?.progress, null);
  assert.ok(Number.isFinite(item?.addedAt));
  assert.ok(Number.isFinite(item?.updatedAt));
});

test('duplicate rows inside one import are reported as merges', async () => {
  const report = await store.importPayload(
    { items: [{ url: 'https://example.com/a' }, { url: 'https://example.com/a' }] },
    compile(),
  );
  assert.deepEqual(report, { created: 1, merged: 1, skipped: 0 });
  assert.equal((await store.listUnread()).length, 1);
});

test('import merges into existing items instead of duplicating them', async () => {
  await store.upsert(draft('https://e.com/a', 'https://e.com/a', 'A', progress(0.9)));
  const payload = await store.exportAll();
  await store.upsert(draft('https://e.com/a', 'https://e.com/a', 'A', progress(0.1)));

  const report = await store.importPayload(payload, compile());
  assert.equal(report.created, 0);
  assert.equal(report.merged, 1);
  const items = await store.listUnread();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.progress?.percent, 0.9, 'merge keeps the furthest progress');
});

test('a merge never trades a real anchor for a bigger percentage', async () => {
  // An empty `textStart` means "percentage known, position not recoverable" — what
  // `scripts/convert-legacy.mjs` emits, because the old extension stored a scroll offset and no
  // anchor text. Comparing on percent alone let that win: importing a converted 95% over a
  // natively saved 90% replaced a working text-fragment restore with a number that cannot
  // restore anything, silently, on the one path that has no undo.
  await store.upsert(
    draft('https://e.com/a', 'https://e.com/a', 'A', progress(0.9, 'the real anchor text')),
  );
  const report = await store.importPayload(
    {
      format: 'read-later',
      schemaVersion: 1,
      items: [
        {
          urlKey: 'https://e.com/a',
          url: 'https://e.com/a',
          title: 'A',
          addedAt: 1,
          updatedAt: 2,
          status: 'unread',
          progress: { scrollY: 9500, docHeight: 10_000, percent: 0.95, textStart: '' },
        },
      ],
    },
    compile(),
  );
  assert.equal(report.merged, 1);
  const items = await store.listUnread();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.progress?.textStart, 'the real anchor text', 'the anchor must survive');
  assert.equal(items[0]?.progress?.percent, 0.9, 'and so must the percentage that goes with it');
});

test('between two anchored progresses the furthest read still wins', async () => {
  await store.upsert(draft('https://e.com/b', 'https://e.com/b', 'B', progress(0.9, 'far anchor')));
  const payload = await store.exportAll();
  await store.upsert(draft('https://e.com/b', 'https://e.com/b', 'B', progress(0.1, 'near anchor')));

  await store.importPayload(payload, compile());
  const items = await store.listUnread();
  assert.equal(items[0]?.progress?.percent, 0.9);
  assert.equal(items[0]?.progress?.textStart, 'far anchor');
});

test('with neither side anchored the percentage still decides', async () => {
  await store.upsert(draft('https://e.com/c', 'https://e.com/c', 'C', progress(0.3, '')));
  const payload = await store.exportAll();
  await store.upsert(draft('https://e.com/c', 'https://e.com/c', 'C', progress(0.6, '')));

  await store.importPayload(payload, compile());
  const items = await store.listUnread();
  assert.equal(items[0]?.progress?.percent, 0.6);
});

test('import rejects a payload from a newer schema instead of silently eating it', async () => {
  await assert.rejects(
    () => store.importPayload({ items: [], schemaVersion: 99 }, compile()),
    /schemaVersion/,
  );
});

test('import skips entries that are not http(s)', async () => {
  const report = await store.importPayload(
    { items: [{ url: 'file:///C:/a.html' }, { url: 'https://example.com/a' }, { nope: true }] },
    compile(),
  );
  assert.equal(report.created, 1);
  assert.equal(report.skipped, 2);
});

test('clearAllItems keeps settings and filters', async () => {
  await store.patchSettings({ filterText: '$removeparam=fbclid' });
  await store.upsert(draft('example.com/a', 'https://example.com/a', 'A'));
  await store.clearAllItems();
  assert.equal((await store.listUnread()).length, 0);
  assert.equal((await store.getSettings()).filterText, '$removeparam=fbclid');
});


test('clearAllItems also clears an older delete undo batch', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.deleteItems(['e.com/a']);
  assert.ok(await store.getLastDeleted());

  await store.clearAllItems();
  assert.equal(await store.getLastDeleted(), null);
  assert.equal(await store.undoDelete(), 0);
});

test('bytesInUse reports a positive footprint once items exist', async () => {
  assert.equal(typeof (await store.bytesInUse()), 'number');
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.3)));
  assert.ok((await store.bytesInUse()) > 0);
});

test('hitting the cap is reported as "full", not as a raw quota string', async () => {
  // `unlimitedStorage` is deliberately not requested, so "full" is a reachable end state
  // and the only write failure with an obvious remedy. With the warning tiers gone, this
  // classification is the entire difference between an actionable message and a puzzle.
  vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(
    new Error('Resource::kQuotaBytes quota exceeded'),
  );
  await assert.rejects(() => store.upsert(draft('example.com/a', 'https://example.com/a', 'A')));
  assert.deepEqual(await store.getLastStorageError(), {
    code: 'quota',
    message: 'Resource::kQuotaBytes quota exceeded',
  });

  vi.restoreAllMocks();
  vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('something else broke'));
  await assert.rejects(() => store.upsert(draft('example.com/b', 'https://example.com/b', 'B')));
  assert.equal((await store.getLastStorageError())?.code, 'other', 'anything else stays generic');
  vi.restoreAllMocks();
});

test('a successful write clears a previous failure', async () => {
  vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota exceeded'));
  await assert.rejects(() => store.upsert(draft('example.com/a', 'https://example.com/a', 'A')));
  vi.restoreAllMocks();
  await store.upsert(draft('example.com/a', 'https://example.com/a', 'A'));
  assert.equal(await store.getLastStorageError(), null);
});


test('a successful session write does not dismiss a persistent quota error', async () => {
  await store.upsert(draft('example.com/a', 'https://example.com/a', 'A'));
  vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValueOnce(new Error('quota exceeded'));
  await assert.rejects(() => store.renameItem('example.com/a', 'Renamed'));
  vi.restoreAllMocks();

  await store.archiveItem('example.com/a');
  assert.equal((await store.getLastStorageError())?.code, 'quota');
});

test('delete aborts when its undo batch cannot be stored', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  vi.spyOn(fakeBrowser.storage.session, 'set').mockRejectedValueOnce(new Error('quota exceeded'));

  await assert.rejects(() => store.deleteItems(['e.com/a']));
  vi.restoreAllMocks();

  assert.equal((await store.listUnread()).length, 1);
  assert.equal(await store.getLastDeleted(), null);
  assert.equal((await store.getLastStorageError())?.code, 'quota');
});

test('a subscribed list is counted apart from the reading list', async () => {
  // They share one 10 MB cap, so a big list genuinely costs items — which is exactly why
  // one conflated number will not do: it would hide which of the two to shrink.
  await store.upsert(draft('example.com/a', 'https://example.com/a', 'A', progress(0.3)));
  const itemsOnly = await store.bytesInUse();
  assert.equal(await store.subscriptionBytes([]), 0, 'no subscriptions, nothing attributed');

  await store.setSubscriptionData('list-1', {
    text: '$removeparam=fbclid\n'.repeat(500),
    title: 'Example list',
    version: null,
    fetchedAt: 1,
    expiresHours: null,
    added: [],
    removed: [],
    addedCount: 0,
    removedCount: 0,
    error: null,
  });

  const lists = await store.subscriptionBytes(['list-1']);
  assert.ok(lists > 1000, `the list should dominate its own figure, got ${lists}`);
  const total = await store.bytesInUse();
  assert.ok(total >= itemsOnly + lists, 'and the total covers both');
  assert.equal(
    await store.subscriptionBytes(['list-1']),
    lists,
    'asking again does not include the item that was there all along',
  );
});

test('a delete is undoable, and puts each item back in the area it came from', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A', progress(0.4)));
  await store.upsert(draft('e.com/b', 'https://e.com/b', 'B'));
  await store.archiveItem('e.com/b');

  await store.deleteItems(['e.com/a', 'e.com/b']);
  assert.equal((await store.listUnread()).length, 0);
  assert.equal((await store.listArchived()).length, 0);
  assert.equal((await store.getLastDeleted())?.entries.length, 2);

  assert.equal(await store.undoDelete(), 2);
  const unread = await store.listUnread();
  assert.equal(unread.length, 1, 'the unread one came back unread');
  assert.equal(unread[0]?.progress?.percent, 0.4, 'with its reading position intact');
  assert.equal((await store.listArchived()).length, 1, 'the archived one came back archived');
  assert.equal(await store.getLastDeleted(), null, 'and the batch is consumed');
});

test('undo skips a key that has come back on its own, rather than clobbering it', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'Old title'));
  await store.deleteItems(['e.com/a']);
  // Saved afresh before the undo: the new save is the newer truth.
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'New title'));

  assert.equal(await store.undoDelete(), 0);
  assert.equal((await store.listUnread())[0]?.title, 'New title');
});

test('only the most recent delete is undoable, and nothing is not an error', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.upsert(draft('e.com/b', 'https://e.com/b', 'B'));
  await store.deleteItems(['e.com/a']);
  await store.deleteItems(['e.com/b']);

  assert.equal(await store.undoDelete(), 1, 'the second delete replaced the first');
  assert.deepEqual((await store.listUnread()).map((i) => i.title), ['B']);
  assert.equal(await store.undoDelete(), 0, 'a second undo is a no-op, not a throw');
});

test('deleting nothing does not arm an undo', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.deleteItems([]);
  assert.equal(await store.getLastDeleted(), null);
  // A key that was never there contributes no entry either.
  await store.deleteItems(['e.com/gone']);
  assert.equal(await store.getLastDeleted(), null);
});

test('unreadCount tracks the unread area only', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.upsert(draft('e.com/b', 'https://e.com/b', 'B'));
  assert.equal(await store.unreadCount(), 2);
  await store.archiveItem('e.com/b');
  assert.equal(await store.unreadCount(), 1);
});

/** A subscribed list large enough that reading its value to count items would be the whole cost. */
const bigList = (): Parameters<typeof store.setSubscriptionData>[1] => ({
  text: '$removeparam=fbclid\n'.repeat(20_000),
  title: 'Example list',
  version: null,
  fetchedAt: 1,
  expiresHours: null,
  added: [],
  removed: [],
  addedCount: 0,
  removedCount: 0,
  error: null,
});

/**
 * The badge is refreshed on every save, archive, delete and storage event, and all it needs is a
 * number — so it must not pay for the subscribed lists that share this area. `get(null)` returns
 * every value, which made each refresh deserialise up to 5 MB of filter text.
 *
 * What is asserted is that production code takes the key-only branch and that the count is right.
 * That the branch is cheaper is a property of the real API, not of the double standing in for it.
 */
test('the unread count reads keys only, never subscribed list values', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.upsert(draft('e.com/b', 'https://e.com/b', 'B'));
  await store.setSubscriptionData('list-1', bigList());

  const getKeys = vi.spyOn(fakeBrowser.storage.local, 'getKeys');

  assert.equal(await store.unreadCount(), 2, 'a sub: key was counted as an item');
  assert.equal(getKeys.mock.calls.length, 1, 'the key-only path was not taken');
  vi.restoreAllMocks();
});

test('the unread count still works where getKeys does not exist', async () => {
  await store.upsert(draft('e.com/a', 'https://e.com/a', 'A'));
  await store.setSubscriptionData('list-1', bigList());

  // `getKeys` is Chrome 130+ / Firefox 140+, so the full-read branch is what older builds run.
  const area = fakeBrowser.storage.local as unknown as { getKeys?: unknown };
  const original = area.getKeys;
  delete area.getKeys;
  try {
    // If the property survived deletion this test would pass through the fast path and prove
    // nothing, so check the precondition rather than trusting it.
    assert.equal(area.getKeys, undefined, 'could not remove getKeys; the fallback went untested');
    assert.equal(await store.unreadCount(), 1);
  } finally {
    area.getKeys = original;
  }
});
