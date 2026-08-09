/**
 * `@webext-core/fake-browser` declares `storage.<area>.getKeys` but throws from it:
 *
 *   storage.local.getKeys not implemented: mock the function yourself using your testing
 *   framework, or submit a PR with an in-memory implementation.
 *
 * This is that in-memory implementation. It matters because `utils/storage.ts` feature-detects
 * the method — it is Chrome 130+ / Firefox 140+ — to count items without deserialising every
 * subscribed filter list alongside them. Presence is a sound check in a real browser; in the
 * double, presence without behaviour would turn every caller into a thrown error instead.
 *
 * Semantics match the real API: every key in that area, nothing else.
 */
import { fakeBrowser } from 'wxt/testing/fake-browser';

for (const area of [fakeBrowser.storage.local, fakeBrowser.storage.session]) {
  area.getKeys = async () => Object.keys(await area.get(null));
}
