import type { Item, SortDir, SortField } from '../utils/types';
import { hostnameOf } from '../utils/normalize';
import { registrableDomain } from '../utils/registrable';

export interface Group {
  key: string;
  items: Item[];
  /** The timestamp that decides where this group sits, per the active sort direction. */
  anchor: number;
}

/**
 * Drops the grouping when there is only one group to show.
 *
 * A lone group header carries nothing the rows don't already say — the domain is on
 * every row's location line, the count is on the view tab — while costing 27px above
 * the first row and putting a collapse-the-whole-list button exactly where the pointer
 * lands when the popup opens. Returning `null` (i.e. render flat) also sidesteps a
 * stale `collapsedGroups` entry hiding the only group with no header left to expand it.
 */
export function visibleGroups(groups: Group[] | null): Group[] | null {
  return groups && groups.length > 1 ? groups : null;
}

export function filterItems(items: Item[], query: string): Item[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.title.toLowerCase().includes(q) || item.url.toLowerCase().includes(q),
  );
}

export function sortItems(items: Item[], field: SortField, dir: SortDir): Item[] {
  const sign = dir === 'asc' ? 1 : -1;
  return items.slice().sort((a, b) => {
    const diff = a[field] - b[field];
    if (diff !== 0) return diff * sign;
    return a.urlKey < b.urlKey ? -1 : a.urlKey > b.urlKey ? 1 : 0;
  });
}

/**
 * Groups follow the same direction as the items: ascending means the group holding
 * the oldest item comes first, so the queue still reads front-to-back once grouped.
 *
 * The key is the registrable domain, computed rather than configured — which is why
 * this file no longer knows the filter layer exists.
 */
export function groupItems(items: Item[], field: SortField, dir: SortDir): Group[] {
  const buckets = new Map<string, Item[]>();
  for (const item of items) {
    const hostname = hostnameOf(item.url);
    const key = hostname ? registrableDomain(hostname) : '(未知域名)';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const groups: Group[] = [];
  buckets.forEach((bucketItems, key) => {
    const stamps = bucketItems.map((i) => i[field]);
    groups.push({
      key,
      items: bucketItems,
      anchor: dir === 'asc' ? Math.min(...stamps) : Math.max(...stamps),
    });
  });

  const sign = dir === 'asc' ? 1 : -1;
  groups.sort((a, b) => {
    const diff = (a.anchor - b.anchor) * sign;
    return diff !== 0 ? diff : a.key < b.key ? -1 : 1;
  });
  return groups;
}

/** Selection is intentionally scoped to the current search/view result. */
export function visibleSelection(selected: string[], visibleKeys: string[]): string[] {
  const visible = new Set(visibleKeys);
  return selected.filter((key) => visible.has(key));
}

export function coversVisibleSelection(selected: string[], visibleKeys: string[]): boolean {
  if (visibleKeys.length === 0) return false;
  const selectedSet = new Set(selected);
  return visibleKeys.every((key) => selectedSet.has(key));
}
