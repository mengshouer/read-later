import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'vitest';

/**
 * A malformed messages.json under `public/_locales` makes Chrome refuse to load the
 * extension outright, and a `__MSG_x__` with no matching key shows up as an empty
 * name. Both are silent until install time, so they are worth asserting here.
 */

const LOCALES = ['en', 'zh_CN'];
/** Keys referenced as `__MSG_*__` from the manifest in `wxt.config.ts`. */
const REQUIRED_KEYS = ['name', 'description', 'commandSaveCurrentTab'];

interface MessageEntry {
  message: string;
  description?: string;
}

function load(locale: string): Record<string, MessageEntry> {
  const path = resolve(process.cwd(), 'public', '_locales', locale, 'messages.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, MessageEntry>;
}

test('every locale file is valid JSON with non-empty messages', () => {
  for (const locale of LOCALES) {
    const messages = load(locale);
    assert.ok(Object.keys(messages).length > 0, `${locale} is empty`);
    for (const [key, entry] of Object.entries(messages)) {
      assert.equal(typeof entry.message, 'string', `${locale}.${key} has no message string`);
      assert.ok(entry.message.trim().length > 0, `${locale}.${key} is blank`);
    }
  }
});

test('all locales define exactly the same keys', () => {
  const [first, ...rest] = LOCALES.map((locale) => Object.keys(load(locale)).sort());
  for (const keys of rest) assert.deepEqual(keys, first);
});

test('every key the manifest references exists in all locales', () => {
  for (const locale of LOCALES) {
    const messages = load(locale);
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in messages, `${locale} is missing ${key}, which the manifest references`);
    }
  }
});

test('the manifest only references keys that exist', () => {
  const config = readFileSync(resolve(process.cwd(), 'wxt.config.ts'), 'utf8');
  const referenced = [...config.matchAll(/__MSG_(\w+)__/g)].map((match) => match[1] as string);
  assert.deepEqual(referenced.slice().sort(), REQUIRED_KEYS.slice().sort());
});
