/**
 * Serves a synthetic long article so the scroll-to-text-fragment assumption behind the whole
 * progress-restore design can be checked against a real browser instead of trusted.
 *
 * Usage: `node scripts/fragment-probe.mjs [port]`, then open the page and follow its link in a
 * NEW TAB (a same-document hash change does not re-run the fragment directive).
 *
 * WHY IT WORKS THE WAY IT DOES. The first version built the fragment from the whole marker
 * sentence, which made it useless: a whole sentence ends on a word boundary, while
 * `captureSnapshot` cuts the anchor at a character budget. Text fragments are matched
 * `wordStartBounded` and — because `buildRestoreUrl` emits neither prefix nor suffix —
 * `mustEndAtWordBoundary` as well, so a cut landing mid-word never matches. The probe therefore
 * reported success for a string production never produced, while every English page silently
 * failed to restore.
 *
 * So the anchor is not restated here. The page runs the REAL `captureSnapshot`, serialised
 * exactly the way `scripting.executeScript({ func })` serialises it, against real geometry —
 * which is the one thing no unit test can check. Only the two-line `text=` assembly is mirrored;
 * `buildRestoreUrl`'s escaping, hash merging and PDF handling have their own tests in
 * `tests/normalize.test.ts`.
 *
 * `utils/injected.ts` has no imports at all — self-containment is what these functions are for —
 * so plain Node can load it without a bundler.
 */
import { createServer } from 'node:http';
import { captureSnapshot } from '../utils/injected.ts';

const PORT = Number(process.argv[2] ?? 8123);
export const MARKER =
  'The service worker will be terminated when idle, so do not rely on module globals.';

function page() {
  const filler = [];
  for (let i = 0; i < 120; i++) {
    filler.push(
      `<p>Filler paragraph number ${i} with enough text to make the document tall and scrollable.</p>`,
    );
  }
  // The marker sits deliberately far down the document.
  filler.splice(90, 0, `<p id="marker">${MARKER}</p>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fragment probe</title>
<style>
  body{font:16px/1.8 system-ui;max-width:40em;margin:2em auto;padding-top:7em}
  p{margin:1.2em 0}
  #out{position:fixed;top:0;left:0;right:0;background:#111;color:#eee;padding:10px 14px;
       font:13px/1.6 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;z-index:9}
  #out a{color:#7cf}
  ::target-text{background:#ffd400}
</style>
</head><body>
<div id="out">running the real captureSnapshot…</div>
<h1>Fragment probe</h1>
${filler.join('\n')}
<script>
// The real function, serialised the way Chrome serialises it for executeScript({ func }).
const captureSnapshot = ${captureSnapshot.toString()};

// Put the marker at the top of the viewport: that is the situation the extension captures in.
document.getElementById('marker').scrollIntoView({ block: 'start' });

requestAnimationFrame(() => requestAnimationFrame(() => {
  const snapshot = captureSnapshot();
  const progress = snapshot.progress;
  const out = document.getElementById('out');

  if (!progress) {
    out.textContent = 'captureSnapshot refused this page: ' + snapshot.reason;
    return;
  }

  // Mirrors the two lines of buildRestoreUrl that assemble the directive. Everything else about
  // it (existing hashes, PDFs, the missing-progress passthrough) is unit-tested.
  const enc = (value) => encodeURIComponent(value).replace(/-/g, '%2D');
  const body = progress.textEnd
    ? 'text=' + enc(progress.textStart) + ',' + enc(progress.textEnd)
    : 'text=' + enc(progress.textStart);
  const restoreUrl = location.origin + location.pathname + '#:~:' + body;

  const endsMidWord = /[0-9A-Za-z]$/.test(progress.textStart)
    && document.body.innerText.replace(/\\s+/g, ' ')
         .split(progress.textStart).length > 1
    && (() => {
         const hay = document.body.innerText.replace(/\\s+/g, ' ');
         const next = hay.charAt(hay.indexOf(progress.textStart) + progress.textStart.length);
         return next !== '' && !/\\s/.test(next);
       })();

  out.innerHTML =
    'textStart   : ' + JSON.stringify(progress.textStart) + '\\n' +
    'textEnd     : ' + JSON.stringify(progress.textEnd) + '\\n' +
    'ends mid-word? ' + (endsMidWord ? 'YES — this can never match' : 'no') + '\\n' +
    'Open in a NEW TAB: <a href="' + restoreUrl + '" target="_blank" rel="noreferrer">' +
    restoreUrl + '</a>\\n' +
    'Scrolled down with the marker highlighted = the anchor matched.';
  console.log('[fragment-probe]', { snapshot, restoreUrl, endsMidWord });
}));
</script>
</body></html>`;
}

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`probe server: http://127.0.0.1:${PORT}/`);
  console.log('Open it, then follow the printed link in a NEW TAB.');
});
