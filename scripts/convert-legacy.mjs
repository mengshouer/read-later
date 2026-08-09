#!/usr/bin/env node
/**
 * Converts a JSONL export from a legacy read-later extension into a payload that
 * this extension's "Import JSON" accepts.
 *
 *   node scripts/convert-legacy.mjs <input.jsonl> [output.json]
 *   cat export.jsonl | node scripts/convert-legacy.mjs - out.json
 *
 * Source shape, one object per line:
 *   { timestamp, title, url, scroll?: { height, percent: "13%", top } }
 *
 * Mapping notes, in rough order of how much thought they needed:
 *
 * - `urlKey` is deliberately NOT emitted. `importPayload` derives it from `url`
 *   using whichever rules are active at import time and never reads an incoming
 *   `urlKey`, so writing one here would be inert at best and misleading at worst —
 *   and re-implementing the normaliser in a script is how the two drift apart.
 *
 * - `scroll` becomes `progress` with an EMPTY `textStart`. Our restore path is the
 *   `#:~:text=` anchor, and the legacy tool never recorded any anchor text, so the
 *   position genuinely cannot be restored. `captureSnapshot` never produces an empty
 *   `textStart` (it returns `progress: null` instead), which makes an empty one an
 *   unambiguous marker for "percent is known, position is not restorable" — the UI
 *   reads it and labels the badge accordingly rather than promising a jump it cannot
 *   make. `buildRestoreUrl` already passes the URL through untouched in that case.
 *
 * - Titles: this exporter stored the URL as the title whenever it had nothing better,
 *   so those get replaced with the URL's path. Not `titleFromUrl`, which is tuned for
 *   article slugs and would turn `_a_snake_cased_name` into `a snake cased name`. A leading
 *   `(4) ` unread counter — a browser tab-title artefact, not part of any real title —
 *   is stripped from the titles that are real.
 *
 * - `titleEdited` is left unset on purpose. Derived titles should be replaced by the
 *   real page title the first time you re-save the page.
 *
 * Every example in this file and in its tests is synthetic, on an RFC 2606 reserved
 * domain. Do not paste rows out of a real export to illustrate a case.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CURRENT_SCHEMA_VERSION = 1;

/** A leading `(12) ` is an unread counter the browser puts in the tab title. */
const UNREAD_COUNTER = /^\(\d+\)\s*/;

function looksLikeUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

/** `https://example.com/tag/SOMETAG?src=x` -> `tag/SOMETAG`. */
function titleFromPath(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (path) return decodeURIComponent(path);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return rawUrl;
  }
}

function cleanTitle(rawTitle, rawUrl) {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title || title === rawUrl || looksLikeUrl(title)) {
    return { title: titleFromPath(rawUrl), derived: true };
  }
  return { title: title.replace(UNREAD_COUNTER, '').trim(), derived: false };
}

function toPercent(scroll) {
  if (typeof scroll.percent === 'string') {
    const parsed = Number.parseFloat(scroll.percent);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed / 100));
  }
  if (typeof scroll.percent === 'number' && Number.isFinite(scroll.percent)) {
    return Math.max(0, Math.min(1, scroll.percent > 1 ? scroll.percent / 100 : scroll.percent));
  }
  const top = Number(scroll.top);
  const height = Number(scroll.height);
  if (Number.isFinite(top) && Number.isFinite(height) && height > 0) {
    return Math.max(0, Math.min(1, top / height));
  }
  return 0;
}

function toProgress(scroll) {
  if (!scroll || typeof scroll !== 'object') return null;
  const scrollY = Number.isFinite(Number(scroll.top)) ? Number(scroll.top) : 0;
  const docHeight = Number.isFinite(Number(scroll.height)) && Number(scroll.height) > 0 ? Number(scroll.height) : 1;
  return {
    scrollY,
    docHeight,
    percent: toPercent(scroll),
    // Empty on purpose — see the header note. Means "percent known, not restorable".
    textStart: '',
  };
}

/**
 * @param {string} text  the raw JSONL
 * @param {{ now?: number }} [options]
 */
export function convertLegacyExport(text, options = {}) {
  const now = options.now ?? Date.now();
  const report = {
    lines: 0,
    converted: 0,
    unparseable: 0,
    missingUrl: 0,
    notHttp: 0,
    duplicateUrls: 0,
    derivedTitles: 0,
    invalidTimestamps: 0,
    scrollCarried: 0,
    dropped: [],
  };

  const byUrl = new Map();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    report.lines++;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      report.unparseable++;
      report.dropped.push({ reason: 'unparseable', line: line.slice(0, 120) });
      continue;
    }

    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url) {
      report.missingUrl++;
      report.dropped.push({ reason: 'no url', line: line.slice(0, 120) });
      continue;
    }
    // Matches `isSavableUrl`: anything else can neither be injected into nor keyed.
    if (!/^https?:\/\//i.test(url)) {
      report.notHttp++;
      report.dropped.push({ reason: 'not http(s)', line: url });
      continue;
    }

    let stamp = Date.parse(entry?.timestamp ?? '');
    if (!Number.isFinite(stamp)) {
      stamp = now;
      report.invalidTimestamps++;
    }

    const { title, derived } = cleanTitle(entry?.title, url);
    if (derived) report.derivedTitles++;

    const progress = toProgress(entry?.scroll);
    if (progress) report.scrollCarried++;

    const item = { url, title, addedAt: stamp, updatedAt: stamp, status: 'unread', progress };

    // Dedup by exact URL only. The authoritative dedup happens at import time, where
    // the real normaliser runs — anything this misses shows up there as a merge.
    const existing = byUrl.get(url);
    if (existing) {
      report.duplicateUrls++;
      existing.addedAt = Math.min(existing.addedAt, item.addedAt);
      existing.updatedAt = Math.max(existing.updatedAt, item.updatedAt);
      if (!existing.progress && item.progress) existing.progress = item.progress;
      if (existing.title !== item.title && !derived) existing.title = item.title;
      continue;
    }
    byUrl.set(url, item);
  }

  const items = [...byUrl.values()].sort((a, b) => a.addedAt - b.addedAt);
  report.converted = items.length;

  return {
    payload: {
      format: 'read-later',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date(now).toISOString(),
      items,
    },
    report,
  };
}

function main(argv) {
  const [input, output] = argv;
  if (!input) {
    console.error('usage: node scripts/convert-legacy.mjs <input.jsonl|-> [output.json]');
    process.exit(1);
  }
  const text = readFileSync(input === '-' ? 0 : input, 'utf8');
  const { payload, report } = convertLegacyExport(text);
  const json = JSON.stringify(payload, null, 2);

  if (output) writeFileSync(output, json + '\n');
  else process.stdout.write(json + '\n');

  const log = output ? console.log : console.error;
  log(`lines read          ${report.lines}`);
  log(`items written       ${report.converted}`);
  log(`titles derived      ${report.derivedTitles}  source entries whose title was just the URL`);
  log(`scroll carried      ${report.scrollCarried}  percentage only — no anchor, so not restorable`);
  if (report.duplicateUrls) log(`duplicate URLs      ${report.duplicateUrls}  (merged)`);
  if (report.invalidTimestamps) log(`bad timestamps      ${report.invalidTimestamps}  (set to conversion time)`);
  for (const drop of report.dropped) log(`dropped [${drop.reason}] ${drop.line}`);
  if (output) log(`\nwrote ${output}`);
}

// Only run the CLI when invoked directly, so tests can import the mapping.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  main(process.argv.slice(2));
}
