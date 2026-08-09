import { strict as assert } from 'node:assert';
import { beforeEach, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import * as store from '../utils/storage';
import {
  ADGUARD_URL_TRACKING,
  DEFAULT_EXPIRES_HOURS,
  diffLists,
  dueSubscriptions,
  isStale,
  listRows,
  parseListMeta,
  permissionOrigin,
  subscriptionId,
  updateSubscription,
  validateListText,
} from '../utils/subscriptions';
import type { Subscription } from '../utils/types';

beforeEach(() => {
  fakeBrowser.reset();
  vi.unstubAllGlobals();
});

const HEADER = [
  '[Adblock Plus 2.0]',
  '! Title: Example tracking filter',
  '! Version: 2.0.13',
  '! Expires: 5 days (update frequency)',
  '! Homepage: https://example.org/filters',
].join('\n');

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: 'list-1',
  url: 'https://example.org/list.txt',
  enabled: true,
  autoUpdate: true,
  ...over,
});

// ---------------------------------------------------------------- metadata

test('the list’s own headers supply its name and update frequency', () => {
  // The ecosystem already has a metadata convention, so there is none to invent — and
  // `! Expires:` means a list states its own cadence instead of us guessing one.
  const meta = parseListMeta(`${HEADER}\n$removeparam=fbclid`);
  assert.equal(meta.title, 'Example tracking filter');
  assert.equal(meta.version, '2.0.13');
  assert.equal(meta.expiresHours, 120);
});

test('Expires accepts hours as well as days, and stays null when absent', () => {
  assert.equal(parseListMeta('! Expires: 12 hours\n$removeparam=x').expiresHours, 12);
  assert.equal(parseListMeta('$removeparam=x').expiresHours, null);
  assert.equal(parseListMeta('$removeparam=x').title, null);
});

test('only the first occurrence of a header wins, so a rule line cannot spoof one', () => {
  const meta = parseListMeta('! Title: Real\n! Title: Later\n$removeparam=x');
  assert.equal(meta.title, 'Real');
});

// ---------------------------------------------------------------- ids

test('the permission origin is null whenever no permission is involved', () => {
  // This decides a destructive action: the options page revokes an origin when the last list
  // using it is unsubscribed. The grant path and the revoke path must compute the identical
  // string, so it lives here as one pure function rather than inline in the component.
  assert.equal(permissionOrigin('/filters/supplement.txt'), null, 'bundled needs no permission');
  assert.equal(permissionOrigin('ftp://lists.example/a.txt'), null);
  assert.equal(permissionOrigin('data:text/plain,x'), null);
  assert.equal(permissionOrigin('not a url'), null);
  assert.equal(permissionOrigin(''), null);
});

test('the permission origin is a match pattern for exactly one origin', () => {
  assert.equal(permissionOrigin('https://lists.example/a.txt'), 'https://lists.example/*');
  assert.equal(permissionOrigin('http://lists.example/a.txt'), 'http://lists.example/*');
  // Host case is folded and a path never widens the pattern.
  assert.equal(permissionOrigin('https://Lists.EXAMPLE/deep/a.txt'), 'https://lists.example/*');
  // A non-default port stays, which narrows the request rather than widening it.
  assert.equal(permissionOrigin('https://lists.example:8443/a.txt'), 'https://lists.example:8443/*');
  // Userinfo is not part of an origin, so it cannot leak into the pattern.
  assert.equal(permissionOrigin('https://user:pw@lists.example/a.txt'), 'https://lists.example/*');
  // Two lists on one origin share a pattern — that is what stops an unsubscribe revoking an
  // origin another subscription still needs.
  assert.equal(
    permissionOrigin('https://lists.example/a.txt'),
    permissionOrigin('https://lists.example/b.txt'),
  );
  assert.notEqual(
    permissionOrigin('https://lists.example/a.txt'),
    permissionOrigin('https://other.example/a.txt'),
  );
});

test('an id is stable, url-specific and safe as a storage key', () => {  const a = subscriptionId('https://example.org/list.txt');
  assert.equal(a, subscriptionId('https://example.org/list.txt'));
  assert.notEqual(a, subscriptionId('https://example.org/other.txt'));
  assert.match(a, /^[a-z0-9-]+$/);
  // Two long URLs sharing a 40-char prefix must not collide onto one key.
  const long = 'https://example.org/very/long/path/that/keeps/going/and/going/';
  assert.notEqual(subscriptionId(long + 'a.txt'), subscriptionId(long + 'b.txt'));
});

// ---------------------------------------------------------------- diff

test('a diff reports rule lines only, ignoring comments and blank lines', () => {
  const before = '! header\n$removeparam=a\n$removeparam=b\n';
  const after = '! different header\n\n$removeparam=b\n$removeparam=c\n';
  const diff = diffLists(before, after);
  assert.deepEqual(diff.added, ['$removeparam=c']);
  assert.deepEqual(diff.removed, ['$removeparam=a']);
  assert.equal(diff.addedCount, 1);
  assert.equal(diff.removedCount, 1);
});

test('a huge diff is capped for display but reports the true totals', () => {
  // A capped list presented as the whole story is the same lie as a silent drop.
  const after = Array.from({ length: 400 }, (_, i) => `$removeparam=p${i}`).join('\n');
  const diff = diffLists('', after);
  assert.equal(diff.added.length, 300);
  assert.equal(diff.addedCount, 400);
});

// ---------------------------------------------------------------- validation

test('anything that is not a filter list is refused', () => {
  assert.equal(validateListText('<!DOCTYPE html><html>login</html>').ok, false);
  assert.equal(validateListText('! just comments\n! and nothing else').ok, false);
  assert.equal(validateListText('').ok, false);
  const good = validateListText(`${HEADER}\n$removeparam=fbclid`);
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.active, 1);
});

test('a list of pure blocking rules counts as unusable here', () => {
  // It parses, but nothing in it can ever change a URL, so accepting it would show
  // "subscribed" next to a list that does nothing.
  assert.equal(validateListText('||example.com^\n||example.org^').ok, false);
});

// ---------------------------------------------------------------- fetching

function stubFetch(body: string | Error, status = 200, headers: Record<string, string> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (body instanceof Error) throw body;
      return {
        ok: status < 400,
        status,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        text: async () => body,
      } as unknown as Response;
    }),
  );
}

/**
 * `response.text()` materialises the whole body, so the 5 MB cap has to be applied before it —
 * otherwise the memory is already spent by the time the list is refused. Auto-update re-fetches
 * daily without asking, which is how a URL that grew reaches us with nobody watching.
 */
test('an oversized Content-Length is refused without reading the body', async () => {
  let bodyRead = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === 'content-length' ? String(6 * 1024 * 1024) : null,
          },
          text: async () => {
            bodyRead = true;
            return `${HEADER}\n$removeparam=fbclid`;
          },
        }) as unknown as Response,
    ),
  );

  const outcome = await updateSubscription(sub(), 1_000);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'too-large');
  assert.equal(bodyRead, false, 'the body was read before the declared size was checked');
});

test('a response that declares no length is still accepted', async () => {
  // `Number(null)` is 0, so a missing header must fall through to the backstop rather than
  // reading as "size unknown, therefore refuse" — that would break every chunked list.
  stubFetch(`${HEADER}\n$removeparam=fbclid`);
  const outcome = await updateSubscription(sub(), 1_000);
  assert.equal(outcome.ok, true);
});

test('a first fetch stores the text with no diff to report', async () => {
  stubFetch(`${HEADER}\n$removeparam=fbclid`);
  const outcome = await updateSubscription(sub(), 1_000);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.firstFetch, true);
  // Reporting all 2,568 lines as "added" would store the list twice for no information.
  assert.equal(outcome.ok && outcome.diff.addedCount, 0);
  const data = await store.getSubscriptionData('list-1');
  assert.equal(data?.title, 'Example tracking filter');
  assert.equal(data?.expiresHours, 120);
  assert.equal(data?.fetchedAt, 1_000);
  assert.equal(data?.error, null);
});

test('a second fetch records what changed', async () => {
  stubFetch(`${HEADER}\n$removeparam=a`);
  await updateSubscription(sub(), 1_000);
  stubFetch(`${HEADER}\n$removeparam=b`);
  const outcome = await updateSubscription(sub(), 2_000);
  assert.deepEqual(outcome.ok && outcome.diff.added, ['$removeparam=b']);
  assert.deepEqual(outcome.ok && outcome.diff.removed, ['$removeparam=a']);
});

test('a failed fetch keeps the previous rules and only records the error', async () => {
  // The property that matters most: a bad fetch degrades to "stale", never to "no rules".
  stubFetch(`${HEADER}\n$removeparam=fbclid`);
  await updateSubscription(sub(), 1_000);

  stubFetch(new Error('network down'));
  const outcome = await updateSubscription(sub(), 2_000);
  assert.equal(outcome.ok, false);
  const data = await store.getSubscriptionData('list-1');
  assert.equal(data?.text.includes('$removeparam=fbclid'), true, 'previous text survived');
  assert.equal(data?.fetchedAt, 1_000, 'and is still dated by its own successful fetch');
  assert.equal(data?.error, 'network down');
});

test('a 404 body that happens to be HTML cannot overwrite working rules', async () => {
  stubFetch(`${HEADER}\n$removeparam=fbclid`);
  await updateSubscription(sub(), 1_000);
  stubFetch('<html><body>Not found</body></html>');
  const outcome = await updateSubscription(sub(), 2_000);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.reason, 'looks-like-html');
  const data = await store.getSubscriptionData('list-1');
  assert.equal(data?.text.includes('$removeparam=fbclid'), true);
});

// ---------------------------------------------------------------- staleness

test('staleness follows the list’s own Expires, with a fallback when it has none', () => {
  const base = { text: '', title: null, version: null, added: [], removed: [], addedCount: 0, removedCount: 0, error: null };
  const hour = 3600_000;
  assert.equal(isStale({ ...base, fetchedAt: 0, expiresHours: 120 }, 119 * hour), false);
  assert.equal(isStale({ ...base, fetchedAt: 0, expiresHours: 120 }, 120 * hour), true);
  assert.equal(isStale({ ...base, fetchedAt: 0, expiresHours: null }, (DEFAULT_EXPIRES_HOURS - 1) * hour), false);
  assert.equal(isStale({ ...base, fetchedAt: 0, expiresHours: null }, DEFAULT_EXPIRES_HOURS * hour), true);
  assert.equal(isStale(null), true, 'never fetched is always due');
});

test('only enabled lists with auto-update on are ever fetched', async () => {
  // Turning a list off should stop its network traffic too, not just its rules.
  const subs = [
    sub({ id: 'on', url: 'https://example.org/a.txt' }),
    sub({ id: 'off', url: 'https://example.org/b.txt', enabled: false }),
    sub({ id: 'manual', url: 'https://example.org/c.txt', autoUpdate: false }),
  ];
  const due = await dueSubscriptions(subs, 0);
  assert.deepEqual(
    due.map((s) => s.id),
    ['on'],
  );
});

test('a fresh list is not re-fetched', async () => {
  stubFetch(`${HEADER}
$removeparam=a`);
  await updateSubscription(sub(), 1_000);
  assert.deepEqual(await dueSubscriptions([sub()], 1_000 + 3600_000), [], 'one hour later, still fresh');
  const later = await dueSubscriptions([sub()], 1_000 + 121 * 3600_000);
  assert.equal(later.length, 1, 'past its declared 5 days, due again');
});

// ---------------------------------------------------------------- the rule list

const BUNDLED = '/filters/supplement.txt';

function ids(rows: ReturnType<typeof listRows>): string[] {
  return rows.map((row) => (row.kind === 'offer' ? `offer:${row.preset.url}` : `list:${row.subscription.url}`));
}

test('both offered lists are rows before anything is subscribed, bundled first', () => {
  const rows = listRows([]);
  assert.deepEqual(ids(rows), [`offer:${BUNDLED}`, `offer:${ADGUARD_URL_TRACKING}`]);
});

test('subscribing to the bundled list still leaves a way to subscribe to the other one', () => {
  // The reported bug: the first version rendered only the lists you had and pushed the rest
  // behind a bare button beside the "add a URL" field, so this state looked like a dead end.
  const rows = listRows([sub({ id: subscriptionId(BUNDLED), url: BUNDLED })]);
  assert.deepEqual(ids(rows), [`list:${BUNDLED}`, `offer:${ADGUARD_URL_TRACKING}`]);
});

test('a subscribed list rises above one that is only on offer', () => {
  const rows = listRows([
    sub({ id: subscriptionId(ADGUARD_URL_TRACKING), url: ADGUARD_URL_TRACKING }),
  ]);
  // The bundled one comes first in `PRESETS`, but it is not in effect and this one is. An
  // inert row carrying a Subscribe button, sitting above the list that is actually cleaning
  // your URLs, was the bug — the section has to answer "what is in effect?" first.
  assert.deepEqual(ids(rows), [`list:${ADGUARD_URL_TRACKING}`, `offer:${BUNDLED}`]);
});

test('the offered lists keep their order however they were subscribed to', () => {
  const rows = listRows([
    sub({ id: subscriptionId(ADGUARD_URL_TRACKING), url: ADGUARD_URL_TRACKING }),
    sub({ id: subscriptionId(BUNDLED), url: BUNDLED }),
  ]);
  assert.deepEqual(ids(rows), [`list:${BUNDLED}`, `list:${ADGUARD_URL_TRACKING}`]);
});

test('a list added by URL comes after the offered ones and is marked as not one of them', () => {
  const custom = sub({ id: 'custom-1', url: 'https://example.org/mine.txt' });
  const rows = listRows([custom, sub({ id: subscriptionId(BUNDLED), url: BUNDLED })]);
  // Subscribed first — presets in `PRESETS` order, then the ones added by URL — and any
  // remaining offer last, where it lands directly above the add-by-URL field.
  assert.deepEqual(ids(rows), [
    `list:${BUNDLED}`,
    'list:https://example.org/mine.txt',
    `offer:${ADGUARD_URL_TRACKING}`,
  ]);
  const customRow = rows[1];
  assert.equal(customRow?.kind === 'list' && customRow.preset, null, 'no preset, so the row shows the Custom chip');
});

test('every offer sits below every subscribed list, whatever the mix', () => {
  const rows = listRows([
    sub({ id: 'custom-1', url: 'https://example.org/a.txt' }),
    sub({ id: 'custom-2', url: 'https://example.net/b.txt' }),
  ]);
  const firstOffer = rows.findIndex((row) => row.kind === 'offer');
  const lastList = rows.map((row) => row.kind).lastIndexOf('list');
  assert.ok(firstOffer > lastList, `offers must not interleave: ${ids(rows).join(', ')}`);
  // Neither preset is subscribed here, so both are still reachable — that is the D60
  // guarantee, and re-sorting the rows must not quietly drop it.
  assert.deepEqual(ids(rows).slice(firstOffer), [`offer:${BUNDLED}`, `offer:${ADGUARD_URL_TRACKING}`]);
});
