import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { Item, Settings } from '../utils/types';
import { DEFAULT_SETTINGS, QUOTA_BYTES } from '../utils/types';
import type { DeletedBatch } from '../utils/types';
import type { Message } from '../utils/messages';
import { openTargetFor } from '../utils/messages';
import type { Translate } from '../utils/i18n';
import { htmlLang, makeTranslate, nextLocaleLabel, resolveLocale } from '../utils/i18n';
import { hostnameOf } from '../utils/normalize';
import * as store from '../utils/storage';
import {
  faviconUrl,
  formatBytes,
  formatFullDate,
  formatPercent,
  formatShortDate,
  hueOf,
  initialOf,
  shortLocation,
} from '../utils/display';
import {
  coversVisibleSelection,
  filterItems,
  groupItems,
  sortItems,
  visibleGroups,
  visibleSelection,
} from './organize';

export type Ctx = 'popup' | 'side' | 'tab';
type View = 'unread' | 'archived';

function send(message: Message): void {
  void browser.runtime.sendMessage(message).catch(() => {
    // The popup is often torn down mid-send; the background has already received it.
  });
}

function Favicon({ url, hostname }: { url: string; hostname: string }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : faviconUrl(url, 32);
  return (
    <span class="favicon" style={{ backgroundColor: `hsl(${hueOf(hostname)} 52% 44%)` }} aria-hidden="true">
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : initialOf(hostname)}
    </span>
  );
}

/** Which modifiers were held, so `openTargetFor` can resolve the target. */
export interface OpenMods {
  inBackground: boolean;
  invert: boolean;
}

interface RowProps {
  item: Item;
  view: View;
  batch: boolean;
  /** `settings.rowActionsEnabled` — governs Copy / Delete, but never Restore. */
  actions: boolean;
  checked: boolean;
  tr: Translate;
  onToggle: (urlKey: string) => void;
  onOpen: (item: Item, mods: OpenMods) => void;
  onDelete: (urlKey: string) => void;
  onRestore: (urlKey: string) => void;
}

function Row({ item, view, batch, actions, checked, tr, onToggle, onOpen, onDelete, onRestore }: RowProps) {
  const hostname = hostnameOf(item.url) ?? '?';

  // Copy and Delete are off until asked for. Restore is not gated: the archive is a
  // misclick buffer and Restore is its only single-item way out, so hiding it behind a
  // toggle would remove the point of having an archive.
  const showActions = !batch && actions;
  const showRestore = !batch && view === 'archived';

  const activate = (event: MouseEvent) => {
    if (batch) {
      onToggle(item.urlKey);
      return;
    }
    onOpen(item, { inBackground: event.ctrlKey || event.metaKey, invert: event.altKey });
  };

  return (
    <div
      class={`row${checked ? ' row--checked' : ''}`}
      title={`${item.title}\n${item.url}\n${tr('row.addedAt', { date: formatFullDate(item.addedAt) })}`}
    >
      <button
        type="button"
        class="row__main"
        aria-pressed={batch ? checked : undefined}
        onClick={activate}
        onAuxClick={(event: MouseEvent) => {
          if (event.button !== 1) return;
          event.preventDefault();
          if (batch) onToggle(item.urlKey);
          else onOpen(item, { inBackground: true, invert: event.altKey });
        }}
      >
        {batch ? (
          <span class={`check${checked ? ' check--checked' : ''}`} aria-hidden="true">
            {checked ? '✓' : ''}
          </span>
        ) : (
          <Favicon url={item.url} hostname={hostname} />
        )}
        <span class="row__body">
          <span class="row__title">{item.title || tr('row.untitled')}</span>
          <span class="row__meta">
            <span class="row__loc">{shortLocation(item.url)}</span>
          </span>
        </span>
        <span class="row__right">
          <span class="row__date">{formatShortDate(item.addedAt)}</span>
          {item.progress ? (
            // An empty `textStart` can only come from an import: the percentage is real
            // but there is no anchor, so the badge must not promise a jump.
            <span
              class={item.progress.textStart ? 'badge badge--progress' : 'badge badge--informational'}
              title={item.progress.textStart ? tr('row.progressTip') : tr('row.progressNoAnchorTip')}
            >
              {formatPercent(item.progress.percent)}
            </span>
          ) : (
            <span class="badge badge--none" title={tr('row.noProgressTip')}>
              —
            </span>
          )}
        </span>
      </button>
      {showActions || showRestore ? (
        // Destructive first, against convention, on purpose. This overlay sits at the
        // row's right edge, which is the column the pointer arrives in when the popup
        // opens under the toolbar icon — so with the toggle on, an immediate click lands
        // on the rightmost button, and it has to be the harmless one.
        <div
          class="row__actions"
          onClick={(event: MouseEvent) => event.stopPropagation()}
          onAuxClick={(event: MouseEvent) => event.stopPropagation()}
        >
          {showActions ? (
            <button type="button" class="danger" onClick={() => onDelete(item.urlKey)}>
              {tr('row.delete')}
            </button>
          ) : null}
          {showRestore ? (
            <button type="button" onClick={() => onRestore(item.urlKey)}>
              {tr('row.restore')}
            </button>
          ) : null}
          {showActions ? (
            <button type="button" onClick={() => void navigator.clipboard.writeText(item.url)}>
              {tr('row.copy')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ListApp({ ctx }: { ctx: Ctx }) {
  const [unread, setUnread] = useState<Item[]>([]);
  const [archived, setArchived] = useState<Item[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [bytes, setBytes] = useState(0);
  const [storageError, setStorageError] = useState<store.StorageError | null>(null);
  const [deleted, setDeleted] = useState<DeletedBatch | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>('unread');
  const [query, setQuery] = useState('');
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const [u, a, s, b, e, d] = await Promise.all([
      store.listUnread(),
      store.listArchived(),
      store.getSettings(),
      store.bytesInUse(),
      store.getLastStorageError(),
      store.getLastDeleted(),
    ]);
    setUnread(u);
    setArchived(a);
    setSettings(s);
    setBytes(b);
    setStorageError(e);
    setDeleted(d);
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
    const onChanged = () => void reload();
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [reload]);

  const locale = useMemo(() => resolveLocale(settings.locale), [settings.locale]);
  const tr = useMemo(() => makeTranslate(locale), [locale]);

  // The HTML shell ships as English; correct it once the stored locale is known. Only the
  // full tab needs its title localised — the popup has no title bar, and the side panel
  // shows the action title rather than the document's.
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
    if (ctx === 'tab') document.title = tr('app.listTitle');
  }, [ctx, locale, tr]);

  const source = view === 'unread' ? unread : archived;
  const visible = useMemo(
    () => sortItems(filterItems(source, query), settings.sortField, settings.sortDir),
    [source, query, settings.sortField, settings.sortDir],
  );
  const groups = useMemo(
    () =>
      visibleGroups(
        settings.groupByDomain ? groupItems(visible, settings.sortField, settings.sortDir) : null,
      ),
    [visible, settings.groupByDomain, settings.sortField, settings.sortDir],
  );

  const collapsed = useMemo(() => new Set(settings.collapsedGroups), [settings.collapsedGroups]);
  const visibleKeys = useMemo(() => visible.map((item) => item.urlKey), [visible]);
  const scopedSelection = useMemo(
    () => visibleSelection(selected, visibleKeys),
    [selected, visibleKeys],
  );
  const selectedSet = useMemo(() => new Set(scopedSelection), [scopedSelection]);
  const allVisibleSelected = coversVisibleSelection(scopedSelection, visibleKeys);

  useEffect(() => {
    setSelected((current) => {
      const next = visibleSelection(current, visibleKeys);
      return next.length === current.length && next.every((key, index) => key === current[index])
        ? current
        : next;
    });
  }, [visibleKeys]);

  const patch = useCallback(async (next: Partial<Settings>) => {
    setSettings(await store.patchSettings(next));
  }, []);

  const onOpen = useCallback(
    (item: Item, mods: OpenMods) => {
      const target = openTargetFor({
        inBackground: mods.inBackground,
        invert: mods.invert,
        preferCurrentTab: settings.openInCurrentTab,
        listOwnsCurrentTab: ctx === 'tab',
      });
      send({ type: 'open-item', urlKey: item.urlKey, target });
      // Reusing the current tab closes the popup too — the write is already the
      // background's job, which is the whole reason opening goes through a message.
      if (target !== 'background' && ctx === 'popup') window.close();
    },
    [ctx, settings.openInCurrentTab],
  );

  const onToggle = useCallback((urlKey: string) => {
    setSelected((prev) => (prev.includes(urlKey) ? prev.filter((k) => k !== urlKey) : [...prev, urlKey]));
  }, []);

  const exitBatch = useCallback(() => {
    setBatch(false);
    setSelected([]);
  }, []);

  const toggleCollapse = useCallback(
    (key: string) => {
      const next = collapsed.has(key)
        ? settings.collapsedGroups.filter((k) => k !== key)
        : [...settings.collapsedGroups, key];
      void patch({ collapsedGroups: next });
    },
    [collapsed, patch, settings.collapsedGroups],
  );

  if (!ready) return <div class="app app--loading">{tr('app.loading')}</div>;

  const renderRows = (items: Item[]) =>
    items.map((item) => (
      <Row
        key={item.urlKey}
        item={item}
        view={view}
        batch={batch}
        actions={settings.rowActionsEnabled}
        checked={selectedSet.has(item.urlKey)}
        tr={tr}
        onToggle={onToggle}
        onOpen={onOpen}
        onDelete={(urlKey) => void store.deleteItems([urlKey]).catch(() => reload())}
        onRestore={(urlKey) => void store.restoreItem(urlKey)}
      />
    ));

  /**
   * The popup opens anchored under the toolbar icon, so the pointer starts just above
   * the top edge: every pixel of chrome above the list is pure travel before the first
   * item can be clicked. Search / tabs / controls therefore sit *below* the list, which
   * puts row 1 within ~25px of where the pointer lands.
   *
   * The full tab is the exception — it is a tall window reached on purpose, so pinning
   * its controls to the bottom of the viewport would move them further away, not closer.
   * That single boolean is also the hook for flipping the popup itself, should the bubble
   * ever be measured opening upwards (a bottom address bar, or a window low on screen).
   */
  const chromeFirst = ctx === 'tab';

  const chrome = (
    <div class={`chrome${chromeFirst ? ' chrome--top' : ''}`}>
      <div class="bar bar--search">
        <input
          class="search"
          type="search"
          placeholder={tr('search.placeholder')}
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
        />
      </div>

      <div class="bar bar--tabs">
        <button
          type="button"
          class={view === 'unread' ? 'tab tab--active' : 'tab'}
          onClick={() => {
            setView('unread');
            exitBatch();
          }}
        >
          {tr('view.unread', { n: unread.length })}
        </button>
        <button
          type="button"
          class={view === 'archived' ? 'tab tab--active' : 'tab'}
          title={tr('view.archivedTip')}
          onClick={() => {
            setView('archived');
            exitBatch();
          }}
        >
          {tr('view.archived', { n: archived.length })}
        </button>
      </div>

      {batch ? (
        <div class="bar bar--batch">
          <button
            type="button"
            onClick={() => setSelected(allVisibleSelected ? [] : visibleKeys)}
          >
            {allVisibleSelected
              ? tr('batch.clearSelection')
              : tr('batch.selectAll')}
          </button>
          <span class="batch__count">{tr('batch.selected', { n: scopedSelection.length })}</span>
          <span class="spacer" />
          <button
            type="button"
            class="danger"
            disabled={scopedSelection.length === 0}
            onClick={async () => {
              try {
                await store.deleteItems(scopedSelection);
                exitBatch();
              } catch {
                await reload();
              }
            }}
          >
            {tr('batch.delete')}
          </button>
          {view === 'unread' ? (
            <button
              type="button"
              disabled={scopedSelection.length === 0}
              onClick={async () => {
                for (const urlKey of scopedSelection) await store.archiveItem(urlKey);
                exitBatch();
              }}
            >
              {tr('batch.archive')}
            </button>
          ) : (
            <button
              type="button"
              disabled={scopedSelection.length === 0}
              onClick={async () => {
                for (const urlKey of scopedSelection) await store.restoreItem(urlKey);
                exitBatch();
              }}
            >
              {tr('batch.restore')}
            </button>
          )}
          <button type="button" onClick={exitBatch}>
            {tr('batch.exit')}
          </button>
        </div>
      ) : (
        <div class="bar bar--controls">
          <button
            type="button"
            title={settings.sortField === 'addedAt' ? tr('ctrl.fieldTipAdded') : tr('ctrl.fieldTipUpdated')}
            onClick={() => void patch({ sortField: settings.sortField === 'addedAt' ? 'updatedAt' : 'addedAt' })}
          >
            {settings.sortField === 'addedAt' ? tr('ctrl.fieldAdded') : tr('ctrl.fieldUpdated')}
          </button>
          <button
            type="button"
            title={settings.sortDir === 'asc' ? tr('ctrl.sortTipAsc') : tr('ctrl.sortTipDesc')}
            onClick={() => void patch({ sortDir: settings.sortDir === 'asc' ? 'desc' : 'asc' })}
          >
            {settings.sortDir === 'asc' ? '↑' : '↓'}
          </button>
          <button
            type="button"
            class={settings.groupByDomain ? 'toggle toggle--on' : 'toggle'}
            title={tr('ctrl.groupTip')}
            onClick={() => void patch({ groupByDomain: !settings.groupByDomain })}
          >
            {settings.groupByDomain ? tr('ctrl.groupOn') : tr('ctrl.groupOff')}
          </button>
          <button
            type="button"
            class={settings.rowActionsEnabled ? 'toggle toggle--on' : 'toggle'}
            aria-pressed={settings.rowActionsEnabled}
            title={settings.rowActionsEnabled ? tr('ctrl.actionsTipOn') : tr('ctrl.actionsTipOff')}
            onClick={() => void patch({ rowActionsEnabled: !settings.rowActionsEnabled })}
          >
            {tr('ctrl.actions')}
          </button>
          <span class="spacer" />
          <button type="button" onClick={() => setBatch(true)} disabled={visible.length === 0}>
            {tr('ctrl.batch')}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div class={`app app--${ctx}`}>
      {/* A failed write outranks pointer economy: this interrupts at the very top. */}
      {storageError ? (
        <div class="banner banner--error">
          <div>
            <strong>{tr(storageError.code === 'quota' ? 'err.quotaTitle' : 'err.storageTitle')}</strong>
            <div class="banner__detail">
              {storageError.code === 'quota' ? tr('err.quotaDetail') : storageError.message}
            </div>
          </div>
          <div class="banner__actions">
            <button type="button" onClick={() => void browser.runtime.openOptionsPage()}>
              {tr('err.exportBackup')}
            </button>
            <button type="button" onClick={() => void store.clearLastStorageError()}>
              {tr('err.dismiss')}
            </button>
          </div>
        </div>
      ) : null}

      {chromeFirst ? chrome : null}

      <div class="list">
        {visible.length === 0 ? (
          <div class="empty">
            {query ? tr('empty.noMatch') : view === 'archived' ? tr('empty.archived') : tr('empty.unread')}
          </div>
        ) : groups ? (
          groups.map((group) => (
            <section class="group" key={group.key}>
              <button type="button" class="group__head" onClick={() => toggleCollapse(group.key)}>
                <span class="group__caret">{collapsed.has(group.key) ? '▸' : '▾'}</span>
                <span class="group__name">{group.key}</span>
                <span class="group__count">{group.items.length}</span>
              </button>
              {collapsed.has(group.key) ? null : renderRows(group.items)}
            </section>
          ))
        ) : (
          renderRows(visible)
        )}
      </div>

      {chromeFirst ? null : chrome}

      {/*
        The old top bar is folded in here: its only unique content was the word
        "Read Later", which the icon tooltip already provides. Item counts are gone
        from this line too — the view tabs directly above carry both of them.
      */}
      <footer class="bar bar--foot">
        {/*
          Used against the real limit, and nothing else. There are no warning tiers: this
          number sits under every list, so the growth is visible without being nagged
          about, and the write that finally does not fit reports itself (see the banner).
        */}
        <span class="foot__usage">
          {tr('foot.usage', { bytes: formatBytes(bytes), limit: formatBytes(QUOTA_BYTES) })}
        </span>
        <div class="foot__nav">
          <button
            type="button"
            title={tr('nav.languageTip')}
            onClick={() => void patch({ locale: locale === 'zh' ? 'en' : 'zh' })}
          >
            {nextLocaleLabel(locale)}
          </button>
          {ctx === 'popup' ? (
            <button
              type="button"
              title={tr('nav.sidePanelTip')}
              onClick={async () => {
                const win = await browser.windows.getCurrent();
                const api = (
                  browser as unknown as {
                    sidePanel?: { open: (options: { windowId: number }) => Promise<void> };
                  }
                ).sidePanel;
                if (api && win.id !== undefined) await api.open({ windowId: win.id });
                window.close();
              }}
            >
              {tr('nav.sidePanel')}
            </button>
          ) : null}
          {ctx === 'tab' ? null : (
            <button
              type="button"
              title={tr('nav.fullPageTip')}
              onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/list.html') })}
            >
              {tr('nav.fullPage')}
            </button>
          )}
          <button type="button" title={tr('nav.settingsTip')} onClick={() => void browser.runtime.openOptionsPage()}>
            {tr('nav.settings')}
          </button>
        </div>
        {/* Its own full-width row — see the note in app.css. Deleting was the one
            destructive action in the list with no way back. */}
        {deleted ? (
          <div class="foot__undo">
            <span>{tr('foot.deleted', { n: deleted.entries.length })}</span>
            <button
              type="button"
              title={tr('foot.undoTip')}
              onClick={() => void store.undoDelete().catch(() => reload())}
            >
              {tr('toast.undo')}
            </button>
          </div>
        ) : null}
      </footer>
    </div>
  );
}
