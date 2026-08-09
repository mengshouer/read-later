import { strict as assert } from 'node:assert';
import { test } from 'vitest';
import { MESSAGE_KEYS, htmlLang, makeTranslate, nextLocaleLabel, resolveLocale, t } from '../utils/i18n';

test('every key resolves to a non-empty string in both locales', () => {
  for (const key of MESSAGE_KEYS) {
    assert.ok(t('en', key).trim().length > 0, `empty en value for ${key}`);
    assert.ok(t('zh', key).trim().length > 0, `empty zh value for ${key}`);
  }
});

test('the Chinese catalogue is actually translated, not a copy of English', () => {
  // A handful of values are legitimately identical (brand names, "English"), so
  // this asserts on the proportion rather than on every single key.
  const identical = MESSAGE_KEYS.filter((key) => t('en', key) === t('zh', key));
  assert.ok(
    identical.length < MESSAGE_KEYS.length * 0.1,
    `too many untranslated keys: ${identical.join(', ')}`,
  );
});

test('placeholders are interpolated', () => {
  assert.equal(t('en', 'view.unread', { n: 12 }), 'Unread 12');
  assert.equal(t('zh', 'view.unread', { n: 12 }), '未读 12');
  assert.equal(t('en', 'batch.selected', { n: 0 }), '0 selected');
});

test('an unsupplied placeholder is left visible rather than printing undefined', () => {
  assert.equal(t('en', 'view.unread'), 'Unread {n}');
  // Asserted by shape, not by wording: this test is about interpolation, and pinning the
  // copy here means every copy edit fails a test that has nothing to do with copy.
  const partial = t('en', 'opt.rekeyDone', { rekeyed: 3 });
  assert.ok(partial.includes('3'), partial);
  assert.ok(partial.includes('{merged}'), partial);
  assert.ok(!partial.includes('undefined'), partial);
});

test('every placeholder in an English string also exists in its Chinese counterpart', () => {
  const names = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).slice().sort();
  for (const key of MESSAGE_KEYS) {
    assert.deepEqual(names(t('zh', key)), names(t('en', key)), `placeholder mismatch for ${key}`);
  }
});

test('auto resolves from the browser language, explicit prefs win', () => {
  assert.equal(resolveLocale('auto', 'zh-CN'), 'zh');
  assert.equal(resolveLocale('auto', 'zh'), 'zh');
  assert.equal(resolveLocale('auto', 'ZH-TW'), 'zh');
  assert.equal(resolveLocale('auto', 'en-US'), 'en');
  assert.equal(resolveLocale('auto', 'de'), 'en', 'anything unsupported falls back to English');
  assert.equal(resolveLocale('auto', ''), 'en');
  assert.equal(resolveLocale('en', 'zh-CN'), 'en');
  assert.equal(resolveLocale('zh', 'en-US'), 'zh');
});

test('the toggle label names the language it switches TO', () => {
  assert.equal(nextLocaleLabel('en'), '中');
  assert.equal(nextLocaleLabel('zh'), 'EN');
});

test('makeTranslate binds the locale', () => {
  assert.equal(makeTranslate('zh')('nav.settings'), '设置');
  assert.equal(makeTranslate('en')('nav.settings'), 'Settings');
});

test('htmlLang gives a real BCP 47 tag, not the internal locale id', () => {
  // `zh` alone would leave the script ambiguous, and the point of setting `lang` at all is
  // CJK glyph selection under Han unification.
  assert.equal(htmlLang('zh'), 'zh-CN');
  assert.equal(htmlLang('en'), 'en');
  // The HTML shells ship with this value, so a mismatch would mean a pointless first-paint
  // correction on every English load.
  assert.equal(htmlLang(resolveLocale('auto', 'de')), 'en');
});
