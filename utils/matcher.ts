import { browser } from 'wxt/browser';
import type { CompiledFilters, FilterSource } from './filters';
import { compileFilters } from './filters';
import * as store from './storage';

/**
 * The cached, storage-reading half of the filter layer.
 *
 * `compileFilters` in `utils/filters.ts` is the pure half — no IO, no cache — and it is
 * what the tests and the options page's live tester use. The tester specifically must
 * NOT come through here: it compiles the draft you are still typing, and a cache keyed
 * on saved settings would make it show yesterday's answer, which would destroy the one
 * thing it exists for.
 *
 * Compiling the full AdGuard list measures at ~8 ms, so this cache is not about a slow
 * parse; it is about not re-reading 174 KB out of storage on every save. A service
 * worker restart flushes it for free, which is also why nothing here has to be clever
 * about invalidation beyond watching the two keys that feed it.
 */

/** Ids are used as storage keys, so keep them to a safe alphabet. */
export const USER_SOURCE_ID = 'user';

let cached: CompiledFilters | null = null;

export function invalidateMatcher(): void {
  cached = null;
}

// Both `settings` (the user's own text, and which lists are enabled) and any `sub:` key
// (a list's fetched text) change what a URL normalises to.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (key === 'settings' || key.startsWith('sub:')) {
      invalidateMatcher();
      return;
    }
  }
});

/**
 * Every text that feeds the matcher, in priority-free order — the model is additive
 * removal plus `@@` exceptions, so there is no ordering to get wrong and a disabled
 * list simply is not here.
 */
export async function filterSources(): Promise<FilterSource[]> {
  const settings = await store.getSettings();
  const sources: FilterSource[] = [];

  const enabled = settings.subscriptions.filter((s) => s.enabled);
  const texts = await store.getSubscriptionMap(enabled.map((s) => s.id));
  for (const subscription of enabled) {
    const data = texts.get(subscription.id);
    if (data && data.text) sources.push({ id: subscription.id, text: data.text });
  }

  // Last, so that in the options page's "which line did this" report the user's own
  // rules are the ones listed after the lists they were written to correct.
  if (settings.filterText.trim() !== '') {
    sources.push({ id: USER_SOURCE_ID, text: settings.filterText });
  }

  return sources;
}

export async function getMatcher(): Promise<CompiledFilters> {
  if (cached) return cached;
  cached = compileFilters(await filterSources());
  return cached;
}
