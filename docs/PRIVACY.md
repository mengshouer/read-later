# Privacy Policy — Read Later

Last updated: 2026-08-09

Read Later is a browser extension that saves pages to a personal reading list and returns you to
the position where you stopped reading. This policy describes everything it does with data.

**Summary: your reading list never leaves your computer. The extension has no server, no account,
no analytics, and makes exactly one kind of network request — downloading a filter list from a URL
you chose to subscribe to.**

## What is stored, and where

Everything is stored by the browser's own extension storage on your computer
(`chrome.storage.local` and `chrome.storage.session`). None of it is transmitted anywhere.

For each item you save:

- the page URL and its title
- the time you saved it and the time it was last updated
- whether it is unread or archived
- the reading position: a scroll offset, the document height, a percentage, and a **short snippet
  of text from the page** — this is what the browser's text-fragment mechanism needs in order to
  scroll back to the same line

Also stored:

- your settings, including any filter rules you typed
- the text of any filter list you subscribed to

Items you open move to session storage and are discarded when you close the browser. Items you
delete are recoverable until the browser closes, then discarded.

## What leaves your computer

One thing, and only when you ask for it: **if you subscribe to a filter list at an `http(s)`
address, the extension downloads that list from the address you entered.** That request goes to
the server you named and contains nothing about you or your reading list beyond what any browser
request contains. It repeats at most once a day while auto-update is on for that list, and stops
entirely when you unsubscribe or turn auto-update off.

Nothing else is sent anywhere. Specifically:

- No analytics, telemetry, crash reporting, or usage measurement of any kind.
- No account, sign-in, or sync service. There is no server operated by this extension.
- Your reading list, the URLs in it, and the page-text snippets are never uploaded.
- Site icons in the list are read from the browser's own local favicon cache, which issues no
  network request.
- Your data is never sold, rented, or shared with anyone, and is not used for advertising,
  credit-worthiness, or lending purposes.
- The extension contains no remotely hosted code. It does not download or execute code. A
  subscribed filter list is parsed as data — text rules that decide whether two URLs are the same
  page — and is never evaluated as code.

## Permissions

- **Right-click menu, storage, side panel** — the extension's own interface and where the list is
  kept.
- **Active tab and scripting** — used only at the moment you save. The extension reads the current
  tab's address and title, measures how far down the page you are, and draws the confirmation card
  in the page. It acts on a tab only in response to your click or keyboard shortcut, and it does
  not run on pages you have not saved from.
- **Alarms** — one check a day for whether a subscribed filter list has passed its own expiry
  window. Removed entirely when no list has auto-update enabled.
- **Access to websites** — *not* granted at install. It is requested at the moment you subscribe
  to a filter list, for that one address, so the list can be downloaded. When you unsubscribe the
  last list from an address, that access is given back up.

## Your control over the data

- **Delete one item, or all of them** — from the list, or Settings → Data → Clear all.
- **Export** — Settings → Data writes your unread list to a JSON file you keep.
- **Remove everything** — uninstalling the extension deletes all of its stored data, including
  subscribed lists and settings. Nothing survives elsewhere, because nothing was ever sent
  elsewhere.

## Changes

Any future change to what is stored or transmitted will be published in this file, with the date
above updated. The version history is public at
<https://github.com/mengshouer/read-later/commits/main/docs/PRIVACY.md>.

## Contact

Questions or reports: <https://github.com/mengshouer/read-later/issues>
