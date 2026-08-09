import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import type { OpenTarget } from '../utils/messages';
import { openTargetFor } from '../utils/messages';

interface Gesture {
  inBackground?: boolean;
  invert?: boolean;
}

const target = (
  gesture: Gesture,
  preferCurrentTab: boolean,
  listOwnsCurrentTab = false,
): OpenTarget =>
  openTargetFor({
    inBackground: gesture.inBackground ?? false,
    invert: gesture.invert ?? false,
    preferCurrentTab,
    listOwnsCurrentTab,
  });

const PLAIN: Gesture = {};
const ALT: Gesture = { invert: true };
const CTRL: Gesture = { inBackground: true };

test('a plain click opens a focused new tab by default', () => {
  assert.equal(target(PLAIN, false), 'foreground');
});

test('with the setting on, a plain click reuses the tab the list was opened over', () => {
  assert.equal(target(PLAIN, true), 'current');
});

test('Ctrl/middle-click always adds a background tab, whatever else is held', () => {
  // This is the "queue several up" gesture from Q14. Letting the setting or Alt capture it
  // would make opening five articles in a row impossible.
  assert.equal(target(CTRL, false), 'background');
  assert.equal(target(CTRL, true), 'background');
  assert.equal(target({ inBackground: true, invert: true }, true), 'background');
});

test('Alt swaps the default, it does not just move it', () => {
  assert.equal(target(ALT, false), 'current', 'setting off: Alt reaches the current tab');
  assert.equal(target(ALT, true), 'foreground', 'setting on: Alt reaches a new focused tab');
});

test('all three targets stay reachable in BOTH settings states', () => {
  // The regression this file exists for. Before Alt was wired up, turning the setting on
  // made 'foreground' unreachable: plain was 'current' and Ctrl/middle was 'background',
  // so there was no gesture left for "new tab, and switch to it".
  for (const preferCurrentTab of [false, true]) {
    const reachable = [PLAIN, ALT, CTRL].map((gesture) => target(gesture, preferCurrentTab));
    assert.deepEqual(
      [...new Set(reachable)].sort(),
      ['background', 'current', 'foreground'],
      `unreachable target with openInCurrentTab=${preferCurrentTab}`,
    );
  }
});

test('the full-tab list never navigates its own tab away, Alt included', () => {
  // Its "current tab" *is* the list, so reusing it would throw away the view, its search
  // box and its scroll position.
  assert.equal(target(PLAIN, true, true), 'foreground');
  assert.equal(target(ALT, false, true), 'foreground', 'Alt cannot force it either');
  assert.equal(target(CTRL, true, true), 'background', 'and Ctrl-click still queues');
});

test('every combination resolves to exactly one of the three targets', () => {
  const seen = new Set<OpenTarget>();
  for (const inBackground of [false, true]) {
    for (const invert of [false, true]) {
      for (const preferCurrentTab of [false, true]) {
        for (const listOwnsCurrentTab of [false, true]) {
          seen.add(target({ inBackground, invert }, preferCurrentTab, listOwnsCurrentTab));
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), ['background', 'current', 'foreground']);
});
