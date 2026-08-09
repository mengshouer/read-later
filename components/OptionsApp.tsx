import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import type { Settings, Subscription } from '../utils/types';
import { DEFAULT_SETTINGS, QUOTA_BYTES } from '../utils/types';
import type { LocalePref, Translate } from '../utils/i18n';
import { htmlLang, makeTranslate, resolveLocale } from '../utils/i18n';
import type { CompiledFilters, FilterSource } from '../utils/filters';
import {
  compileFilters,
  countSkipped,
  formatLineRanges,
  groupSkipped,
} from '../utils/filters';
import type { SubscriptionData } from '../utils/storage';
import * as store from '../utils/storage';
import type { ListPreset, UpdateOutcome } from '../utils/subscriptions';
import {
  isBundled,
  listRows,
  permissionOrigin,
  subscriptionId,
  updateSubscription,
} from '../utils/subscriptions';
import { USER_SOURCE_ID } from '../utils/matcher';
import { MENU_PREFIX_MAX, MENU_SYNC_GRACE_MS, menuDefinitions, sanitizeMenuPrefix } from '../utils/menu';
import { decideQueryFor, normalizeUrl } from '../utils/normalize';
import { formatBytes, formatFullDate } from '../utils/display';

type Note = { tone: 'ok' | 'bad'; text: string } | null;

const SYNTAX_DOCS = 'https://github.com/gorhill/uBlock/wiki/Static-filter-syntax#removeparam';
/** Storage and fetch failures arrive as unknown; this is what the user is shown. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function importMessageOf(error: unknown, tr: Translate): string {
  if (!(error instanceof store.ImportPayloadError)) return messageOf(error);
  switch (error.code) {
    case 'invalid-object':
      return tr('opt.importInvalidObject');
    case 'missing-items':
      return tr('opt.importMissingItems');
    case 'newer-schema':
      return tr('opt.importNewerSchema');
  }
}
/** The one line the "drop everything" button writes. Visible, editable, deletable. */
const NUKE_LINE = '$removeparam';

/**
 * The same source list `getMatcher()` assembles, but built from state this page already
 * holds — so a recompute or an import uses exactly what the tester just showed, including
 * a subscription that was disabled a second ago.
 */
function sourcesOf(
  settings: Settings,
  subData: Map<string, SubscriptionData>,
  userText: string,
): FilterSource[] {
  const sources = settings.subscriptions
    .filter((s) => s.enabled)
    .map((s) => ({ id: s.id, text: subData.get(s.id)?.text ?? '' }))
    .filter((s) => s.text !== '');
  if (userText.trim() !== '') sources.push({ id: USER_SOURCE_ID, text: userText });
  return sources;
}

export function OptionsApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [filterDraft, setFilterDraft] = useState('');
  const [draftLoaded, setDraftLoaded] = useState(false);
  /** Raw, so a space survives typing; only the stored value goes through sanitising. */
  const [prefixDraft, setPrefixDraft] = useState('');
  const [subData, setSubData] = useState<Map<string, SubscriptionData>>(new Map());
  /** One row's expansion at a time: the rules and the diff are two views of the same list. */
  const [expanded, setExpanded] = useState<{ id: string; what: 'rules' | 'diff' } | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [subUrl, setSubUrl] = useState('');
  const [testerUrl, setTesterUrl] = useState('');
  const [rekeyPlan, setRekeyPlan] = useState<store.RekeyPlan | null>(null);
  const [bytes, setBytes] = useState(0);
  /** Shown apart from the total: a big list must not read as a big reading list. */
  const [listBytes, setListBytes] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [storageError, setStorageError] = useState<store.StorageError | null>(null);
  /** What the background reports it actually put on the menu; null before it has run once. */
  const [appliedMenu, setAppliedMenu] = useState<string[] | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [ready, setReady] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const s = await store.getSettings();
    const [b, lb, u, a, e, m, subs] = await Promise.all([
      store.bytesInUse(),
      store.subscriptionBytes(s.subscriptions.map((sub) => sub.id)),
      store.listUnread(),
      store.listArchived(),
      store.getLastStorageError(),
      store.getAppliedMenuTitles(),
      store.getSubscriptionMap(s.subscriptions.map((sub) => sub.id)),
    ]);
    setSettings(s);
    setBytes(b);
    setListBytes(lb);
    setUnreadCount(u.length);
    setArchivedCount(a.length);
    setStorageError(e);
    setAppliedMenu(m);
    setSubData(subs);
    setReady(true);
    return s;
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await reload();
      // Seed the textarea once, so a later reload cannot clobber unsaved edits.
      setFilterDraft(s.filterText);
      setPrefixDraft(s.menuPrefix);
      setDraftLoaded(true);
    })();
  }, [reload]);

  /**
   * The menu diagnostic further down compares what this page expects against what the
   * background actually wrote — and the background writes it *after* we hand it the new
   * prefix. Read once at mount, that comparison was a guaranteed false alarm: every
   * keystroke moved `expected` while the applied titles stayed frozen at their mount-time
   * value, so the warning fired on every edit and then never cleared, all while the menu
   * itself was already correct.
   *
   * `reload` deliberately does not touch the drafts, so re-running it mid-typing cannot
   * clobber what is being typed.
   */
  useEffect(() => {
    const onChanged = () => void reload();
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [reload]);

  const locale = useMemo(() => resolveLocale(settings.locale), [settings.locale]);
  const tr = useMemo(() => makeTranslate(locale), [locale]);

  // The HTML shell ships as English; correct both once the stored locale is known. The
  // title matters here now that this page opens in a real tab instead of an embedded dialog.
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
    document.title = tr('opt.title');
  }, [locale, tr]);

  const patch = useCallback(async (next: Partial<Settings>) => {
    setSettings(await store.patchSettings(next));
  }, []);

  /** What the two menu items should say, given the current locale and prefix. */
  const expectedMenu = useMemo(
    () => menuDefinitions(settings.menuPrefix, tr).map((def) => def.title),
    [settings.menuPrefix, tr],
  );

  /**
   * Three states, because `null` is the most informative one and swallowing it is exactly what
   * made this hard to diagnose: session storage is cleared when the browser closes, so `null`
   * after a restart means `syncMenus` has not run once this session.
   */
  const menuState: 'ok' | 'never' | 'stale' =
    appliedMenu === null ? 'never' : appliedMenu.join('') === expectedMenu.join('') ? 'ok' : 'stale';

  /**
   * A mismatch is the *normal* state for one round trip to the background, so surfacing it the
   * instant it appears reports nothing the user can act on. Both of its previous shapes were
   * wrong: read once at mount it stuck forever, and once the page became reactive it flashed
   * yellow too fast to read. The state was never the problem — the missing notion of time was.
   *
   * So the warning waits out `MENU_SYNC_GRACE_MS`. Until then the preview stands in, which is
   * what the menu will say by the time you have finished reading it, and it keeps this slot from
   * changing colour or height for something that is about to resolve itself. Every edit restarts
   * the clock, so the wait is counted from when you stopped typing rather than from the first
   * keystroke of a burst.
   */
  const [menuMismatchSettled, setMenuMismatchSettled] = useState(false);
  useEffect(() => {
    setMenuMismatchSettled(false);
    if (menuState === 'ok') return;
    const timer = setTimeout(() => setMenuMismatchSettled(true), MENU_SYNC_GRACE_MS);
    return () => clearTimeout(timer);
  }, [menuState, expectedMenu]);

  /** Only the user's own lines, so a subscription's gaps never look like your typos. */
  const draftCompiled = useMemo(
    () => compileFilters([{ id: USER_SOURCE_ID, text: filterDraft }]),
    [filterDraft],
  );

  /** Per subscription, so the three-way count belongs to a specific list. */
  const subCompiled = useMemo(() => {
    const out = new Map<string, CompiledFilters>();
    for (const subscription of settings.subscriptions) {
      const data = subData.get(subscription.id);
      if (data) out.set(subscription.id, compileFilters([{ id: subscription.id, text: data.text }]));
    }
    return out;
  }, [settings.subscriptions, subData]);

  /**
   * Everything that would be active if the draft were saved. Compiled only while the
   * tester has something in it, because rebuilding the full ~3,800-line set costs ~8 ms —
   * worth paying exactly while you are watching the answer.
   *
   * Not the only keystroke that pays it, though. The menu-prefix field writes on every
   * `onInput`, which fires `storage.onChanged` -> `reload()` -> a fresh `subData` Map, and that
   * invalidates `subCompiled` and recompiles every subscription. Measured against this ~8 ms
   * it is unnoticeable in a field capped at `MENU_PREFIX_MAX`, so it is left alone — but a
   * second hot path does exist, and anyone optimising here should know where it is.
   */
  const testerCompiled = useMemo(
    () => (testerUrl.trim() === '' ? null : compileFilters(sourcesOf(settings, subData, filterDraft))),
    [testerUrl, settings, subData, filterDraft],
  );

  const addSubscription = useCallback(
    async (rawUrl: string) => {
      const url = rawUrl.trim();
      if (!url) return;

      const id = subscriptionId(url);
      if (settings.subscriptions.some((subscription) => subscription.id === id)) {
        setNote({ tone: 'bad', text: tr('sub.duplicate') });
        return;
      }

      let grantedOrigin: string | null = null;
      let newlyGranted = false;
      if (!isBundled(url)) {
        grantedOrigin = permissionOrigin(url);
        if (!grantedOrigin) {
          setNote({ tone: 'bad', text: tr('sub.invalidUrl') });
          return;
        }

        try {
          const alreadyGranted = await browser.permissions.contains({ origins: [grantedOrigin] });
          if (!alreadyGranted) {
            // Requested from this click, so a default install holds no host permission.
            const granted = await browser.permissions.request({ origins: [grantedOrigin] });
            if (!granted) {
              setNote({ tone: 'bad', text: tr('sub.denied') });
              return;
            }
            newlyGranted = true;
          }
        } catch (error) {
          setNote({ tone: 'bad', text: tr('sub.failed', { message: messageOf(error) }) });
          return;
        }
      }

      const rollbackCreation = async () => {
        await store.removeSubscriptionData(id).catch(() => {});
        if (newlyGranted && grantedOrigin) {
          await browser.permissions.remove({ origins: [grantedOrigin] }).catch(() => false);
        }
      };

      const subscription: Subscription = { id, url, enabled: true, autoUpdate: true };
      setUpdating(id);
      let outcome: UpdateOutcome;
      try {
        outcome = await updateSubscription(subscription);
      } catch (error) {
        await rollbackCreation();
        setNote({ tone: 'bad', text: tr('sub.failed', { message: messageOf(error) }) });
        return;
      } finally {
        setUpdating(null);
      }
      if (!outcome.ok) {
        await rollbackCreation();
        setNote({ tone: 'bad', text: tr('sub.failed', { message: outcome.reason }) });
        return;
      }
      try {
        // Re-read, because `patchSettings` replaces `subscriptions` wholesale and the array this
        // callback closed over was captured before a fetch that can take tens of seconds. Writing
        // the stale copy resurrected a list unsubscribed during the fetch and reverted toggles
        // flipped during it. The controls are disabled while a fetch runs, which covers one page;
        // this covers a second options tab, which `options_ui.open_in_tab` makes possible.
        const fresh = await store.getSettings();
        if (fresh.subscriptions.some((existing) => existing.id === id)) {
          await rollbackCreation();
          setNote({ tone: 'bad', text: tr('sub.duplicate') });
          await reload();
          return;
        }
        await store.patchSettings({ subscriptions: [...fresh.subscriptions, subscription] });
      } catch (error) {
        await rollbackCreation();
        setNote({ tone: 'bad', text: tr('sub.failed', { message: messageOf(error) }) });
        await reload();
        return;
      }
      // Full reload rather than just the texts: the byte figures moved too, and a list is
      // the one thing here big enough for that to matter.
      await reload();
      setSubUrl('');
      setNote({
        tone: 'ok',
        text: tr('sub.added', {
          name: outcome.data.title ?? url,
          active: compileFilters([{ id, text: outcome.data.text }]).active,
        }),
      });
    },
    [reload, settings.subscriptions, tr],
  );

  const updateOne = useCallback(
    async (subscription: Subscription) => {
      const name = subData.get(subscription.id)?.title ?? subscription.url;
      setUpdating(subscription.id);
      let outcome: UpdateOutcome;
      try {
        outcome = await updateSubscription(subscription);
      } catch (error) {
        // Same shape as `addSubscription`: the store write inside can rethrow, and without this
        // the row stayed on "Updating…" for the rest of the page's life. Nothing is removed
        // here — a failed *re*fetch keeps the previous text, which is the whole point of Q12.
        setNote({ tone: 'bad', text: tr('sub.updateFailed', { name, message: messageOf(error) }) });
        return;
      } finally {
        setUpdating(null);
        await reload();
      }
      setNote(
        outcome.ok
          ? {
              tone: 'ok',
              text: tr('sub.updateDone', {
                name,
                added: outcome.diff.addedCount,
                removed: outcome.diff.removedCount,
              }),
            }
          : { tone: 'bad', text: tr('sub.updateFailed', { name, message: outcome.reason }) },
      );
    },
    [reload, settings.subscriptions, subData, tr],
  );

  const removeOne = useCallback(
    async (subscription: Subscription) => {
      const name = subData.get(subscription.id)?.title ?? subscription.url;
      if (!window.confirm(tr('sub.confirmRemove', { name }))) return;

      const origin = permissionOrigin(subscription.url);
      try {
        // Re-read for the same reason `addSubscription` does, and it matters more here: this
        // array decides both the write and whether an origin's permission is REVOKED. Computed
        // from a stale closure it could drop a list added since, or revoke an origin a list added
        // since still needs.
        const fresh = await store.getSettings();
        const remaining = fresh.subscriptions.filter((item) => item.id !== subscription.id);

        // Metadata first: if this persistent write fails, both the list text and its permission
        // remain intact and the subscription is still usable.
        await store.patchSettings({ subscriptions: remaining });
        await store.removeSubscriptionData(subscription.id);

        if (origin && !remaining.some((item) => permissionOrigin(item.url) === origin)) {
          // Reported separately: by this point the unsubscribe itself has already succeeded, so
          // failing to hand the permission back must not be announced as a failed unsubscribe.
          const dropped = await browser.permissions.remove({ origins: [origin] }).catch(() => false);
          if (!dropped) {
            await reload();
            setNote({ tone: 'bad', text: tr('sub.removedKeptPermission', { name, origin }) });
            return;
          }
        }
      } catch (error) {
        await reload();
        setNote({ tone: 'bad', text: tr('sub.removeFailed', { name, message: messageOf(error) }) });
        return;
      }

      await reload();
      setNote({ tone: 'ok', text: tr('sub.removed', { name }) });
    },
    [reload, subData, tr],
  );

  const toggleSub = useCallback(
    async (subscription: Subscription, field: 'enabled' | 'autoUpdate', value: boolean) => {
      // Same re-read: this writes the whole array too.
      const fresh = await store.getSettings();
      setSettings(
        await store.patchSettings({
          subscriptions: fresh.subscriptions.map((s) =>
            s.id === subscription.id ? { ...s, [field]: value } : s,
          ),
        }),
      );
    },
    [],
  );

  const exportJson = useCallback(async () => {
    const payload = await store.exportAll();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    // A plain anchor download from an extension page needs no `downloads` permission.
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = payload.exportedAt.slice(0, 19).replace(/[:T]/g, '-');
    anchor.href = url;
    anchor.download = `read-later-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNote({ tone: 'ok', text: tr('opt.exported', { n: payload.items.length }) });
  }, [tr]);

  const importJson = useCallback(
    async (file: File) => {
      try {
        const report = await store.importPayload(
          JSON.parse(await file.text()),
          compileFilters(sourcesOf(settings, subData, settings.filterText)),
        );
        await reload();
        setNote({ tone: 'ok', text: tr('opt.importDone', { ...report }) });
      } catch (error) {
        setNote({
          tone: 'bad',
          text: tr('opt.importFailed', { message: importMessageOf(error, tr) }),
        });
      }
    },
    [reload, settings, subData, tr],
  );

  if (!ready || !draftLoaded) return <div class="options">{tr('app.loading')}</div>;

  const filtersDirty = filterDraft !== settings.filterText;
  const rows = listRows(settings.subscriptions);
  /** Nothing is rewriting URLs at all — the same question `getMatcher()` asks. */
  const nothingActive = sourcesOf(settings, subData, settings.filterText).length === 0;
  /** Whether the bundled supplement is live, which decides what the `$denyallow` note says. */
  const supplementEnabled = settings.subscriptions.some((s) => s.enabled && isBundled(s.url));
  /** A `$removeparam` with no pattern and no exception anywhere is the one real footgun. */
  const nukeUnguarded =
    draftCompiled.block.always.some((f) => f.value.kind === 'all') &&
    draftCompiled.allow.always.length + draftCompiled.allow.byHost.size + draftCompiled.allow.generic.length === 0;

  const localeOptions: Array<{ value: LocalePref; label: string }> = [
    { value: 'auto', label: tr('opt.langAuto') },
    { value: 'en', label: tr('opt.langEn') },
    { value: 'zh', label: tr('opt.langZh') },
  ];

  return (
    <div class="options">
      <h1>{tr('opt.title')}</h1>
      <p class="lede">{tr('opt.lede')}</p>

      <section class="section">
        <h2>{tr('opt.behaviourSection')}</h2>
        <div class="check-row">
          <input
            id="badge"
            type="checkbox"
            checked={settings.badgeEnabled}
            onChange={(event) => void patch({ badgeEnabled: (event.target as HTMLInputElement).checked })}
          />
          <label for="badge">{tr('opt.badgeLabel')}</label>
        </div>
        <div class="check-row">
          <input
            id="reuse-tab"
            type="checkbox"
            checked={settings.openInCurrentTab}
            onChange={(event) => void patch({ openInCurrentTab: (event.target as HTMLInputElement).checked })}
          />
          <label for="reuse-tab">
            {tr('opt.openInCurrentTab')}
            <p class="hint">{tr('opt.openInCurrentTabHint')}</p>
          </label>
        </div>
        <div class="check-row">
          <input
            id="close-after-save"
            type="checkbox"
            checked={settings.closeTabAfterSavingPage}
            onChange={(event) =>
              void patch({ closeTabAfterSavingPage: (event.target as HTMLInputElement).checked })
            }
          />
          <label for="close-after-save">
            {tr('opt.closeAfterSave')}
            <p class="hint">{tr('opt.closeAfterSaveHint')}</p>
          </label>
        </div>
        <div class="actions">
          <label>
            {tr('opt.menuPrefix')}{' '}
            <input
              type="text"
              maxLength={MENU_PREFIX_MAX}
              style={{ width: '120px', display: 'inline-block' }}
              value={prefixDraft}
              // `onInput`, not `onChange`: a text field's `change` event only fires on blur,
              // so typing a prefix and going straight to the context menu saved nothing.
              // The draft stays raw so a space can be typed — only the stored value is
              // sanitised, which is why the preview below reads from settings, not the draft.
              onInput={(event) => {
                const raw = (event.target as HTMLInputElement).value;
                setPrefixDraft(raw);
                void patch({ menuPrefix: sanitizeMenuPrefix(raw) });
              }}
            />
          </label>
        </div>
        {/*
          Reads back what the background actually wrote onto the menu, not what this page would
          compute — and only says so once the mismatch has outlived one round trip (see
          `menuMismatchSettled`). The copy then names the one thing a *published* user can do:
          the enable/disable toggle on the extensions page, which restarts the worker and re-runs
          the top-level sync. "Reload the extension" was wrong twice over — unnecessary here, and
          a developer-mode-only button for an unpacked build.
        */}
        {menuState !== 'ok' && menuMismatchSettled ? (
          <p class="note note--warn">
            {menuState === 'never'
              ? tr('opt.menuPrefixNever')
              : tr('opt.menuPrefixStale', { titles: (appliedMenu ?? []).join(' / ') })}
          </p>
        ) : (
          <p class="note">{`${tr('opt.menuPrefixPreview')} ${expectedMenu.join(' / ')}`}</p>
        )}
        <p class="hint">{tr('opt.menuPrefixHint')}</p>
        {/* Before the button, not after: with no key bound out of the box, this sentence is
            the reason to press it. */}
        <p class="hint">{tr('opt.shortcutHint')}</p>
        <div class="actions">
          <button type="button" onClick={() => void browser.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
            {tr('opt.shortcutButton')}
          </button>
        </div>
      </section>
      <section class="section">
        <h2>{tr('opt.filtersSection')}</h2>
        <p class="hint">{tr('opt.filtersHint')}</p>
        <p class="hint">
          <a href={SYNTAX_DOCS} target="_blank" rel="noreferrer noopener">
            {tr('opt.filtersDocsLabel')}
          </a>
        </p>

        <h3>{tr('sub.section')}</h3>
        <p class="hint">{tr('sub.hint')}</p>
        {/*
          Every offered list is always a row, subscribed or not. The previous version only
          rendered the ones you had, and put the others behind a bare button next to the
          "add a URL" field — so after subscribing to just the bundled list, the way to add
          the AdGuard one was technically present and effectively invisible.
        */}
        {rows.map((row) => {
          if (row.kind === 'offer') {
            const preset = row.preset;
            return (
              <div class="pack" key={preset.url}>
                <div class="pack__head">
                  <strong>{tr(preset.nameKey)}</strong>
                  {isBundled(preset.url) ? <span class="chip">{tr('sub.bundled')}</span> : null}
                  <span class="spacer" />
                  <button
                    type="button"
                    disabled={updating !== null}
                    onClick={() => void addSubscription(preset.url)}
                  >
                    {updating === subscriptionId(preset.url) ? tr('sub.updating') : tr('sub.add')}
                  </button>
                </div>
                <p class="hint">{tr(preset.descriptionKey)}</p>
              </div>
            );
          }
          const subscription = row.subscription;
          return (
            <ListRow
              key={subscription.id}
              subscription={subscription}
              preset={row.preset}
              data={subData.get(subscription.id) ?? null}
              compiled={subCompiled.get(subscription.id) ?? null}
              busy={updating !== null}
              updating={updating === subscription.id}
              expanded={expanded && expanded.id === subscription.id ? expanded.what : null}
              supplementEnabled={supplementEnabled}
              tr={tr}
              onExpand={(what) => setExpanded(what === null ? null : { id: subscription.id, what })}
              onToggle={(field, value) => void toggleSub(subscription, field, value)}
              onUpdate={() => void updateOne(subscription)}
              onRemove={() => void removeOne(subscription)}
            />
          );
        })}

        <div class="actions">
          <input
            type="text"
            style={{ flex: '1 1 320px' }}
            placeholder={tr('sub.addPlaceholder')}
            value={subUrl}
            onInput={(event) => setSubUrl((event.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            disabled={subUrl.trim() === '' || updating !== null}
            onClick={() => void addSubscription(subUrl)}
          >
            {tr('sub.add')}
          </button>
        </div>
        <p class="hint">{tr('sub.needsPermission')}</p>
        {nothingActive ? <p class="note note--warn">{tr('opt.filtersEmptyLede')}</p> : null}

        <h3>{tr('opt.filtersMine')}</h3>
        <textarea
          class="rules"
          spellcheck={false}
          value={filterDraft}
          onInput={(event) => setFilterDraft((event.target as HTMLTextAreaElement).value)}
        />
        {draftCompiled.skipped.length > 0 ? (
          <ul class="errors">
            {draftCompiled.skipped.map((skipped) => (
              <li key={`${skipped.line}-${skipped.raw}`}>
                {tr('opt.errLine', { line: skipped.line, message: skipped.reason })} —{' '}
                <code>{skipped.raw}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {nukeUnguarded ? <p class="note note--warn">{tr('opt.nukeUnguarded')}</p> : null}
        <div class="actions">
          <button
            type="button"
            disabled={!filtersDirty}
            onClick={async () => {
              await patch({ filterText: filterDraft });
              setNote({ tone: 'ok', text: tr('opt.filterSaved') });
            }}
          >
            {tr('opt.filterSave')}
          </button>
          <button type="button" disabled={!filtersDirty} onClick={() => setFilterDraft(settings.filterText)}>
            {tr('opt.filterDiscard')}
          </button>
          {/*
            The old "global aggressive dedup" checkbox, turned into text. It used to inject
            an invisible `* strip: *` at the bottom of the rule set, which was the one
            exception to "everything that rewrites your URLs is a line you can read".
          */}
          <button
            type="button"
            disabled={filterDraft.split(/\r?\n/).some((line) => line.trim() === NUKE_LINE)}
            onClick={() =>
              setFilterDraft((current) =>
                current.trim() === '' ? `${NUKE_LINE}\n` : `${current.replace(/\s*$/, '')}\n${NUKE_LINE}\n`,
              )
            }
          >
            {tr('opt.insertNuke')}
          </button>
        </div>
        <p class="hint">{tr('opt.insertNukeHint')}</p>

        <Tester
          compiled={testerCompiled}
          url={testerUrl}
          onUrl={setTesterUrl}
          subscriptions={settings.subscriptions}
          data={subData}
          tr={tr}
        />
        <h3>{tr('opt.rekeySection')}</h3>
        <p class="hint">{tr('opt.rekeyHint')}</p>
        <div class="actions">
          <button
            type="button"
            onClick={async () => {
              const compiled = compileFilters(sourcesOf(settings, subData, settings.filterText));
              setRekeyPlan(await store.planRecompute(compiled));
            }}
          >
            {tr('opt.rekeyPreview')}
          </button>
        </div>
        {rekeyPlan ? (
          <>
            <p class={rekeyPlan.merged > 0 ? 'note note--warn' : 'note'}>
              {rekeyPlan.rekeyed === 0 && rekeyPlan.merged === 0
                ? tr('opt.rekeyPlanClean')
                : tr('opt.rekeyPlan', { rekeyed: rekeyPlan.rekeyed, merged: rekeyPlan.merged })}
            </p>
            {rekeyPlan.losing.length > 0 ? (
              <>
                <p class="note note--bad">{tr('opt.rekeyLosing', { n: rekeyPlan.losing.length })}</p>
                <pre class="builtin">
                  {rekeyPlan.losing.map((entry) => `${entry.url}\n  → ${entry.intoUrl}`).join('\n')}
                </pre>
              </>
            ) : null}
            <div class="actions">
              <button
                type="button"
                class={rekeyPlan.losing.length > 0 ? 'danger' : undefined}
                disabled={rekeyPlan.rekeyed === 0 && rekeyPlan.merged === 0}
                onClick={async () => {
                  const compiled = compileFilters(sourcesOf(settings, subData, settings.filterText));
                  // The plan is handed back so the write can refuse if it would now discard a URL
                  // the preview never named. Neither the items nor the filters are frozen while
                  // this panel is open, and a merge is the one step nothing can undo.
                  const result = await store.recomputeAllKeys(
                    compiled,
                    rekeyPlan.losing.map((entry) => entry.url),
                  );
                  if (!result.ok) {
                    setRekeyPlan(await store.planRecompute(compiled));
                    setNote({ tone: 'bad', text: tr('opt.rekeyStale', { n: result.unnamed.length }) });
                    return;
                  }
                  setRekeyPlan(null);
                  await reload();
                  setNote({
                    tone: 'ok',
                    text: tr('opt.rekeyDone', { rekeyed: result.rekeyed, merged: result.merged }),
                  });
                }}
              >
                {tr('opt.rekeyConfirm')}
              </button>
              <button type="button" onClick={() => setRekeyPlan(null)}>
                {tr('opt.rekeyCancel')}
              </button>
            </div>
          </>
        ) : null}
      </section>
      <section class="section">
        <h2>{tr('opt.storageSection')}</h2>
        <p class="hint">{tr('opt.storageHint')}</p>
        <div class="stats">
          <div class="stat">
            <div class="stat__value">{formatBytes(bytes)}</div>
            <div class="stat__label">{tr('opt.statBytes')}</div>
          </div>
          <div class="stat">
            <div class="stat__value">{unreadCount}</div>
            <div class="stat__label">{tr('opt.statUnread')}</div>
          </div>
          <div class="stat">
            <div class="stat__value">{archivedCount}</div>
            <div class="stat__label">{tr('opt.statArchived')}</div>
          </div>
          <div class="stat">
            <div class="stat__value">{formatBytes(listBytes)}</div>
            <div class="stat__label">{tr('opt.statLists')}</div>
          </div>
          <div class="stat">
            <div class="stat__value">{formatBytes(QUOTA_BYTES)}</div>
            <div class="stat__label">{tr('opt.statLimit')}</div>
          </div>
        </div>
        {storageError ? (
          <p class="note note--bad">
            {storageError.code === 'quota'
              ? `${tr('err.quotaTitle')} ${tr('err.quotaDetail')}`
              : tr('opt.lastWriteError', { message: storageError.message })}
          </p>
        ) : null}
        {/*
          The remedy, stated once and placed after the numbers rather than before them —
          it only means anything once you have seen how much is used. Export first is the
          order that matters: `importPayload` merges, so the file really does bring the
          items back (`export then import round-trips the unread list`).
        */}
        <p class="hint">{tr('opt.storageFreeHint')}</p>
      </section>
      <section class="section">
        <h2>{tr('opt.dataSection')}</h2>
        <p class="hint">{tr('opt.dataHint')}</p>
        <div class="actions">
          <button type="button" onClick={() => void exportJson()}>
            {tr('opt.export')}
          </button>
          <button type="button" onClick={() => fileInput.current?.click()}>
            {tr('opt.import')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const input = event.target as HTMLInputElement;
              const file = input.files && input.files[0];
              if (file) void importJson(file);
              input.value = '';
            }}
          />
          <button
            type="button"
            class="danger"
            onClick={async () => {
              if (!window.confirm(tr('opt.clearConfirm', { unread: unreadCount, archived: archivedCount }))) return;
              await store.clearAllItems();
              await reload();
              setNote({ tone: 'ok', text: tr('opt.cleared') });
            }}
          >
            {tr('opt.clearAll')}
          </button>
        </div>
      </section>
      <section class="section">
        <h2>{tr('opt.langSection')}</h2>
        <p class="hint">{tr('opt.langHint')}</p>
        <div class="actions">
          {localeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              class={settings.locale === option.value ? 'toggle toggle--on' : 'toggle'}
              onClick={() => void patch({ locale: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      {note ? <p class={note.tone === 'ok' ? 'note note--ok' : 'note note--bad'}>{note.text}</p> : null}
    </div>
  );
}

interface ListRowProps {
  subscription: Subscription;
  /** Set when this is one of the offered lists, so the name stays stable once subscribed. */
  preset: ListPreset | null;
  data: SubscriptionData | null;
  compiled: CompiledFilters | null;
  /** Some list is fetching, so every fetch button is disabled. */
  busy: boolean;
  /** This list is the one fetching. */
  updating: boolean;
  expanded: 'rules' | 'diff' | null;
  supplementEnabled: boolean;
  tr: Translate;
  onExpand: (what: 'rules' | 'diff' | null) => void;
  onToggle: (field: 'enabled' | 'autoUpdate', value: boolean) => void;
  onUpdate: () => void;
  onRemove: () => void;
}

/** One subscribed list: its state, its counts, and what it could not honour. */
function ListRow({
  subscription,
  preset,
  data,
  compiled,
  busy,
  updating,
  expanded,
  supplementEnabled,
  tr,
  onExpand,
  onToggle,
  onUpdate,
  onRemove,
}: ListRowProps) {
  const counts = compiled ? countSkipped(compiled) : null;
  const gaps = counts ? counts.unsupported + counts.invalid : 0;
  const name = preset ? tr(preset.nameKey) : (data?.title ?? subscription.url);

  return (
    <div class="pack">
      <div class="pack__head">
        <strong>{name}</strong>
        {isBundled(subscription.url) ? <span class="chip">{tr('sub.bundled')}</span> : null}
        {preset === null ? <span class="chip">{tr('sub.custom')}</span> : null}
        <span class="spacer" />
        {/*
          Disabled while any list is fetching, like Update above. A fetch can take tens of
          seconds, and every one of these writes the whole `subscriptions` array — so a toggle
          flipped mid-fetch was silently reverted when the in-flight handler wrote its own
          snapshot back, and an unsubscribe was silently undone the same way.
        */}
        <label class="sub__toggle">
          <input
            type="checkbox"
            checked={subscription.enabled}
            disabled={busy}
            onChange={(event) => onToggle('enabled', (event.target as HTMLInputElement).checked)}
          />{' '}
          {tr('sub.enabled')}
        </label>
        <label class="sub__toggle">
          <input
            type="checkbox"
            checked={subscription.autoUpdate}
            disabled={busy}
            onChange={(event) => onToggle('autoUpdate', (event.target as HTMLInputElement).checked)}
          />{' '}
          {tr('sub.autoUpdate')}
        </label>
      </div>

      <p class="hint">
        {compiled ? <span>{tr('sub.counts', { active: compiled.active })}</span> : null}
        {counts && counts['not-applicable'] > 0 ? (
          <>
            {' · '}
            <span title={tr('sub.notApplicableTip')}>
              {tr('sub.countsNotApplicable', { n: counts['not-applicable'] })}
            </span>
          </>
        ) : null}
        {gaps > 0 ? (
          <>
            {' · '}
            <span class="sub__gap" title={tr('sub.unsupportedTip')}>
              {tr('sub.countsUnsupported', { n: gaps })}
            </span>
          </>
        ) : null}
        {' · '}
        {data ? tr('sub.updated', { when: formatFullDate(data.fetchedAt) }) : tr('sub.never')}
        {data?.version ? ` · ${data.version}` : ''}
      </p>

      {data?.error ? <p class="note note--warn">{tr('sub.error', { message: data.error })}</p> : null}

      <div class="actions">
        {data && data.addedCount + data.removedCount > 0 ? (
          <button type="button" onClick={() => onExpand(expanded === 'diff' ? null : 'diff')}>
            {tr('sub.diff', { added: data.addedCount, removed: data.removedCount })}
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={onUpdate}>
          {updating ? tr('sub.updating') : tr('sub.updateNow')}
        </button>
        <button type="button" onClick={() => onExpand(expanded === 'rules' ? null : 'rules')}>
          {expanded === 'rules' ? tr('sub.hide') : tr('sub.view')}
        </button>
        <button type="button" class="danger" disabled={busy} onClick={onRemove}>
          {tr('sub.remove')}
        </button>
      </div>

      {expanded === 'diff' && data ? (
        <>
          {data.addedCount > data.added.length || data.removedCount > data.removed.length ? (
            <p class="hint">
              {tr('sub.diffCapped', {
                shown: data.added.length + data.removed.length,
                total: data.addedCount + data.removedCount,
              })}
            </p>
          ) : null}
          <pre class="builtin">
            {[
              ...data.added.map((line) => `+ ${line}`),
              ...data.removed.map((line) => `- ${line}`),
            ].join('\n')}
          </pre>
        </>
      ) : null}

      {/* Read-only, but present: rules that rewrite your URLs must be readable. */}
      {expanded === 'rules' && data ? <pre class="builtin">{data.text.trim()}</pre> : null}

      {compiled && gaps > 0 ? (
        <div class="skipped">
          {groupSkipped(compiled)
            .filter((group) => group.bucket !== 'not-applicable')
            .map((group) => (
              <div class="skipped__group" key={`${group.bucket}-${group.reason}`}>
                <div>
                  <code>{group.reason}</code>{' '}
                  <span class="hint">
                    {tr('sub.skippedGroup', {
                      count: group.count,
                      lines: formatLineRanges(group.lines),
                    })}
                  </span>
                </div>
                {group.params.length > 0 ? (
                  <p class="hint">{tr('sub.skippedParams', { params: group.params.join(', ') })}</p>
                ) : (
                  <p class="hint">
                    <code>{group.sample}</code>
                  </p>
                )}
                {/*
                  The one cause a real list hits in bulk, and the only one where a reader
                  would reasonably worry — `utm_source` is in there. So it gets said plainly
                  rather than left as a raw reason string.
                */}
                {group.reason === '$denyallow without $domain' ? (
                  <p class="hint">
                    {tr('sub.denyallowExplain')}{' '}
                    {supplementEnabled ? tr('sub.denyallowCovered') : tr('sub.denyallowUncovered')}
                  </p>
                ) : null}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  );
}

interface TesterProps {
  compiled: CompiledFilters | null;
  url: string;
  onUrl: (value: string) => void;
  subscriptions: Subscription[];
  data: Map<string, SubscriptionData>;
  tr: Translate;
}

/**
 * The answer to "I cannot read this syntax".
 *
 * `$removeparam=~/^(v|t)=/` is genuinely harder to read than the `keep: v,t` it replaced,
 * and no amount of documentation fixes that. So instead of explaining the line, this shows
 * what it does to a URL you recognise — and names the list and line number that acted,
 * which is also how a rule you did not expect gets tracked down.
 */
function Tester({ compiled, url, onUrl, subscriptions, data, tr }: TesterProps) {
  const sourceLabel = (id: string): string => {
    if (id === USER_SOURCE_ID) return tr('opt.testerSourceUser');
    return data.get(id)?.title ?? subscriptions.find((s) => s.id === id)?.url ?? id;
  };

  const hits = (
    label: string,
    list: Array<{ param: string; filter: { source: string; line: number; raw: string } }>,
  ) => (
    <div class="kv">
      <span class="kv__k">{label}</span>
      <ul class="kv__v">
        {list.map((hit) => (
          <li key={`${hit.param}-${hit.filter.source}-${hit.filter.line}`}>
            <strong>{hit.param}</strong> — {sourceLabel(hit.filter.source)}:{hit.filter.line}{' '}
            <code>{hit.filter.raw}</code>
          </li>
        ))}
      </ul>
    </div>
  );

  let body = null;
  const trimmed = url.trim();
  if (compiled !== null && trimmed !== '') {
    // One entry point, so the report and the key below it cannot disagree. Doing the parsing and
    // the host folding here as well used to make them contradict each other: for a host with a
    // trailing FQDN dot the key correctly dropped `x` while this report listed `x` as kept.
    const verdict = decideQueryFor(trimmed, compiled);
    if (verdict === null) {
      body = <p class="note note--warn">{tr('opt.testerInvalid')}</p>;
    } else {
      const { params, decision } = verdict;
      const kept = params.filter((_, i) => decision.keep[i]).map((p) => p.name);
      const normalized = normalizeUrl(trimmed, compiled);
      body = (
        <>
          <div class="kv">
            <span class="kv__k">{tr('opt.testerKey')}</span>
            <code class="kv__v">{normalized ? normalized.urlKey : '—'}</code>
          </div>
          <div class="kv">
            <span class="kv__k">{tr('opt.testerKept')}</span>
            <span class="kv__v">{kept.length > 0 ? kept.join(', ') : '—'}</span>
          </div>
          {decision.removedBy.length === 0 && decision.sparedBy.length === 0 ? (
            <p class="hint">{tr('opt.testerNoChange')}</p>
          ) : null}
          {decision.removedBy.length > 0 ? hits(tr('opt.testerRemoved'), decision.removedBy) : null}
          {decision.sparedBy.length > 0 ? hits(tr('opt.testerSpared'), decision.sparedBy) : null}
        </>
      );
    }
  }

  return (
    <>
      <h3>{tr('opt.testerLabel')}</h3>
      <p class="hint">{tr('opt.testerHint')}</p>
      <div class="actions">
        <input
          type="text"
          style={{ flex: '1 1 420px' }}
          placeholder={tr('opt.testerPlaceholder')}
          value={url}
          onInput={(event) => onUrl((event.target as HTMLInputElement).value)}
        />
      </div>
      {body}
    </>
  );
}
