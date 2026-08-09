/**
 * Differential probe: our matcher against uBlock Origin's real engine.
 *
 *   node scripts/filter-probe.mjs [list-url] [--verbose]
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The claim this project makes is that a rule written
 * in the options page also works pasted into uBO. Only uBO can settle that, and only
 * against the real, live lists — but the answer changes whenever upstream publishes, so
 * pinning it into `pnpm test` would turn an unrelated upstream edit into a red build. This
 * repo already separates the two: `fragment-probe.mjs` measures real browser behaviour,
 * `layout-probe.html` measures real boxes, and `tests/` stays deterministic and offline.
 *
 * WHAT COUNTS AS PASSING: zero *unexplained* differences. A difference is explained when
 * the line behind it is one our compiler already reports as `unsupported` or
 * `not-applicable` — in other words, when the options page is already telling the user
 * about it. Anything else is a bug in `utils/filters.ts`.
 *
 * `@gorhill/ubo-core` is GPL-3.0 and this project is MIT, which is exactly why it lives in
 * devDependencies and is imported from here only: nothing in `.output/` links against it.
 */
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { compileFilters, countSkipped, queryParamsOf } from '../utils/filters.ts';
import { decideQueryFor } from '../utils/normalize.ts';

const DEFAULT_LIST = 'https://filters.adtidy.org/extension/ublock/filters/17.txt';

/**
 * URLs to compare on. Real hostnames on purpose — the point is to exercise the rules the
 * list actually ships, and a corpus of `example.com` would match almost nothing. Nothing
 * here comes from a reading list; each entry is a shape (a video id, a share param, a
 * campaign tag), typed out to hit a specific class of rule.
 */
const CORPUS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=newsletter&si=abc123',
  'https://www.youtube.com/shorts/abcdef?si=xyz',
  'https://www.bilibili.com/video/BV1xx411c7mD?p=2&spm_id_from=333.788&vd_source=deadbeef',
  'https://mp.weixin.qq.com/s?__biz=MzA5&mid=100&idx=1&sn=abcdef&chksm=noise&scene=21',
  'https://www.amazon.com/dp/B000000000?tag=aff-20&th=1&psc=1&ref_=nav_signin',
  'https://www.reddit.com/r/programming/comments/abc123/title/?utm_medium=android_app&sort=top',
  'https://news.ycombinator.com/item?id=40000000',
  'https://twitter.com/someuser/status/1700000000000000000?s=20&t=abcdefg',
  'https://www.aliexpress.com/item/1005000000000.html?spm=a2g0o.home&scm=1007.abc&pdp_npi=4',
  'https://item.taobao.com/item.htm?id=600000000000&scm=1007.abc&spm=a21n0.1&skuId=1',
  'https://www.google.com/search?q=filter+syntax&client=firefox-b-d&ei=abc&ved=2ahUKE',
  'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abcdef0123456789',
  'https://www.linkedin.com/posts/someone_activity-7000000000000000000-abcd?utm_source=share&li_fat_id=1',
  'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster?rq=1',
  'https://developer.mozilla.org/en-US/docs/Web/API/URL?retiredLocale=de',
  'https://www.zhihu.com/question/20000000/answer/300000000?utm_psn=1&utm_id=0',
  'https://juejin.cn/post/7000000000000000000?searchId=abc',
  'https://v2ex.com/t/900000?p=2',
  'https://example.com/plain',
  'https://example.com/a?utm_source=x&fbclid=y&gclid=z&id=7',
  'https://shop.example.com/p/1?af_xp=custom&clickid=abc&irclickid=def',
  'https://news.example.org/story?ncid=1&icid=2&at_medium=email&at_campaign=3',
];

function parseArgs(argv) {
  const rest = argv.slice(2);
  const verbose = rest.includes('--verbose');
  const source = rest.find((arg) => !arg.startsWith('--')) ?? DEFAULT_LIST;
  return { source, verbose };
}

/**
 * `node:https` rather than `fetch`, because Node 24's bundled undici crashes with
 * `assert(!this.paused)` when this server closes the connection — reproducible with a bare
 * one-line `node -e 'fetch(...)'`, so it is neither this script's fault nor ubo-core's.
 * The extension itself is unaffected: its `fetch` runs in the browser.
 */
function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) {
      reject(new Error('too many redirects'));
      return;
    }
    https
      .get(url, { headers: { 'user-agent': 'read-later-filter-probe' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve(download(new URL(response.headers.location, url).toString(), redirects + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject);
  });
}

/**
 * A local path is accepted so the probe can be re-run offline against the same bytes.
 *
 * The list is read BEFORE `@gorhill/ubo-core` is imported: the engine is only needed once
 * there is something to feed it, and keeping the import late also keeps its 1.5 MB of
 * GPL-licensed code out of the module graph when the download fails.
 */
async function loadList(source) {
  if (!/^https?:\/\//i.test(source)) {
    console.log(`reading ${source}`);
    return readFile(source, 'utf8');
  }
  console.log(`fetching ${source}`);
  return download(source);
}

/** The params our matcher keeps, as a comparable string. */
function oursKept(compiled, rawUrl) {
  // Through the same entry point the extension uses, so this cannot drift from the real answer.
  const verdict = decideQueryFor(rawUrl, compiled);
  if (verdict === null) return [];
  return verdict.params.filter((_, i) => verdict.decision.keep[i]).map((p) => p.pair);
}

/** The params uBO keeps, read back out of the URL it would have redirected to. */
function theirsKept(engine, rawUrl) {
  const result = engine.filterQuery({ url: rawUrl, type: 'main_frame', originURL: rawUrl });
  const effective = result && result.redirectURL ? result.redirectURL : rawUrl;
  const url = new URL(effective);
  return queryParamsOf(url).map((p) => p.pair);
}

async function main() {
  const { source, verbose } = parseArgs(process.argv);

  const raw = await loadList(source);
  const lines = raw.split(/\r?\n/).length;

  const compiled = compileFilters([{ id: 'probe', text: raw }]);
  const buckets = countSkipped(compiled);
  console.log(
    `list: ${lines} lines → ours: ${compiled.active} active, ` +
      `${buckets['not-applicable']} not applicable, ${buckets.unsupported} unsupported, ` +
      `${buckets.invalid} invalid`,
  );

  // A saved page is a first-party top-level document, and `originURL === url` is how that
  // is expressed to the engine. This is also what validates the request-type reasoning: if
  // treating `$xhr` rules as inert were wrong, those rules would show up as differences.
  const { StaticNetFilteringEngine } = await import('@gorhill/ubo-core');
  const engine = await StaticNetFilteringEngine.create();
  await engine.useLists([{ name: 'probe', raw }]);

  let matched = 0;
  const diffs = [];
  for (const target of CORPUS) {
    const ours = oursKept(compiled, target);
    const theirs = theirsKept(engine, target);
    if (ours.join('&') === theirs.join('&')) {
      matched++;
      if (verbose) console.log(`  ok   ${target}\n       kept: ${ours.join('&') || '(none)'}`);
      continue;
    }
    diffs.push({ target, ours, theirs });
  }

  console.log(`\n${matched}/${CORPUS.length} URLs identical`);
  if (diffs.length > 0) {
    console.log(`\n${diffs.length} difference(s):`);
    for (const diff of diffs) {
      console.log(`\n  ${diff.target}`);
      console.log(`    ours  : ${diff.ours.join('&') || '(none)'}`);
      console.log(`    uBO   : ${diff.theirs.join('&') || '(none)'}`);
      const onlyOurs = diff.ours.filter((p) => !diff.theirs.includes(p));
      const onlyTheirs = diff.theirs.filter((p) => !diff.ours.includes(p));
      if (onlyOurs.length) console.log(`    we keep, uBO drops : ${onlyOurs.join(', ')}`);
      if (onlyTheirs.length) console.log(`    uBO keeps, we drop : ${onlyTheirs.join(', ')}`);
    }
    console.log(
      '\nEach difference must be traceable to a line this compiler already reports as ' +
        'unsupported or not-applicable. Anything else is a bug in utils/filters.ts.',
    );
    process.exitCode = 1;
    return;
  }
  console.log('no differences — every rule class in this list behaves as uBO does');

  await checkSupplementPairing(raw);
}

/**
 * The shipped supplement restates 21 rules AdGuard emits in a shape uBO voids
 * (`$denyallow` with no `$domain`), `utm_source` among them. The claim that makes that
 * safe is that AdGuard's own per-site `@@` exceptions are valid, are honoured, and keep
 * protecting those sites once both lists compile into one pool.
 *
 * That claim cannot be tested offline — it needs the real exceptions — so it is checked
 * here, against whichever site the list currently excepts.
 */
async function checkSupplementPairing(listText) {
  const supplement = await readFile(new URL('../public/filters/supplement.txt', import.meta.url), 'utf8');
  const compiled = compileFilters([
    { id: 'list', text: listText },
    { id: 'supplement', text: supplement },
  ]);

  // Whichever hosts the list currently writes `@@…$removeparam=utm_source` for.
  const excepted = [
    ...new Set(
      listText
        .split(/\r?\n/)
        .filter((line) => line.startsWith('@@') && /removeparam=utm_source\b/.test(line))
        .map((line) => /\|\|([a-z0-9.-]+)\^/i.exec(line))
        .filter(Boolean)
        .map((match) => match[1].toLowerCase()),
    ),
  ];

  console.log('\nsupplement pairing:');
  const plain = oursKept(compiled, 'https://example.com/a?utm_source=x&id=7');
  const strips = !plain.includes('utm_source=x');
  console.log(`  ${strips ? 'ok  ' : 'FAIL'} utm_source is stripped on an ordinary site`);
  if (!strips) process.exitCode = 1;

  if (excepted.length === 0) {
    console.log('  ..   the list ships no host-anchored utm_source exception right now');
    return;
  }
  for (const host of excepted.slice(0, 3)) {
    const kept = oursKept(compiled, `https://${host}/page?utm_source=x&id=7`);
    const spared = kept.includes('utm_source=x');
    console.log(`  ${spared ? 'ok  ' : 'FAIL'} ${host} keeps it, via the list's own @@ exception`);
    if (!spared) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
