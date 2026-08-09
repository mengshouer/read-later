import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import {
  coversVisibleSelection,
  filterItems,
  groupItems,
  sortItems,
  visibleGroups,
  visibleSelection,
} from '../components/organize';
import type { Item } from '../utils/types';

function item(url: string, title: string, addedAt: number): Item {
  return { urlKey: url, url, title, addedAt, updatedAt: addedAt, status: 'unread', progress: null };
}

const ITEMS: Item[] = [
  item('https://docs.example.com/a', 'Docs page', 300),
  item('https://example.com/one', 'First repo', 100),
  item('https://example.org/p/1', '中文文章', 200),
  item('https://example.com/two', 'Preact repo', 400),
];

test('ascending sort puts the oldest first so the queue drains', () => {
  const sorted = sortItems(ITEMS, 'addedAt', 'asc');
  assert.deepEqual(
    sorted.map((i) => i.addedAt),
    [100, 200, 300, 400],
  );
});

test('descending sort puts the newest first', () => {
  assert.deepEqual(
    sortItems(ITEMS, 'addedAt', 'desc').map((i) => i.addedAt),
    [400, 300, 200, 100],
  );
});

test('sort is stable for identical timestamps', () => {
  const same = [item('https://b.example/x', 'B', 5), item('https://a.example/x', 'A', 5)];
  assert.deepEqual(
    sortItems(same, 'addedAt', 'asc').map((i) => i.title),
    ['A', 'B'],
  );
});

test('grouping folds subdomains into the registrable domain, with no rule to write', () => {
  // This used to need `*.example.com group: example.com` in the rule text. Every one of
  // the ten aliases the grouping pack shipped was this exact fold, so it is computed now.
  const groups = groupItems(sortItems(ITEMS, 'addedAt', 'asc'), 'addedAt', 'asc');
  assert.deepEqual(
    groups.map((g) => `${g.key}:${g.items.length}`),
    ['example.com:3', 'example.org:1'],
  );
});

test('group order follows the sort direction', () => {
  const asc = groupItems(sortItems(ITEMS, 'addedAt', 'asc'), 'addedAt', 'asc');
  const desc = groupItems(sortItems(ITEMS, 'addedAt', 'desc'), 'addedAt', 'desc');
  assert.equal(asc[0]?.key, 'example.com', 'group holding the oldest item comes first when ascending');
  assert.equal(desc[0]?.key, 'example.com', 'group holding the newest item comes first when descending');
  assert.deepEqual(
    desc.map((g) => g.key),
    ['example.com', 'example.org'],
  );
});

test('items keep the outer sort order inside each group', () => {
  const groups = groupItems(sortItems(ITEMS, 'addedAt', 'asc'), 'addedAt', 'asc');
  assert.deepEqual(
    groups[0]?.items.map((i) => i.addedAt),
    [100, 300, 400],
  );
});

test('search matches title and url, case-insensitively', () => {
  assert.equal(filterItems(ITEMS, 'preact').length, 1);
  assert.equal(filterItems(ITEMS, 'EXAMPLE.ORG').length, 1);
  assert.equal(filterItems(ITEMS, '中文').length, 1);
  assert.equal(filterItems(ITEMS, '   ').length, ITEMS.length, 'blank query is not a filter');
  assert.equal(filterItems(ITEMS, 'nothing-here').length, 0);
});

test('a lone group is dropped so nothing sits above the first row', () => {
  const oneDomain = [item('https://example.com/a', 'A', 100), item('https://example.com/b', 'B', 200)];
  const grouped = groupItems(oneDomain, 'addedAt', 'asc');
  assert.equal(grouped.length, 1, 'grouping itself still produces the single bucket');
  assert.equal(visibleGroups(grouped), null, 'but it is not worth a header, so render flat');
});

test('two or more groups keep their headers', () => {
  const grouped = groupItems(sortItems(ITEMS, 'addedAt', 'asc'), 'addedAt', 'asc');
  assert.equal(visibleGroups(grouped)?.length, 2);
});

test('a fold that collapses everything into one group also drops the header', () => {
  const grouped = groupItems(
    [item('https://docs.example.com/a', 'A', 100), item('https://example.com/b', 'B', 200)],
    'addedAt',
    'asc',
  );
  assert.equal(grouped.length, 1);
  assert.equal(visibleGroups(grouped), null);
});

test('visibleGroups passes null through when grouping is off, and copes with an empty list', () => {
  assert.equal(visibleGroups(null), null);
  assert.equal(visibleGroups(groupItems([], 'addedAt', 'asc')), null);
});

test('selection is intersected with visible results rather than hidden by the query', () => {
  assert.deepEqual(visibleSelection(['a', 'hidden', 'b'], ['b', 'a']), ['a', 'b']);
  assert.deepEqual(visibleSelection(['hidden'], ['a', 'b']), []);
});

test('select-all checks membership, not only equal array lengths', () => {
  assert.equal(coversVisibleSelection(['a', 'b'], ['a', 'b']), true);
  assert.equal(coversVisibleSelection(['a', 'hidden'], ['a', 'b']), false);
  assert.equal(coversVisibleSelection([], []), false);
});
