# 6. Development and tests

*Chapter 6 of the [manual](../README.md#the-manual). The process for a change is in [CONTRIBUTING.md](../CONTRIBUTING.md).*

Requirements: Node.js 22 or newer (Wrangler 4 needs it) and a Chromium for the browser tests. (`npm run build` also makes `seed/empty.html`, the empty wiki the browser tests start from.)

```bash
npm install
npx playwright install chromium      # or: export CHROMIUM_PATH=/path/to/chrome
npm test                             # build (worker.js and seed/empty.html), run all eighteen suites
```

`npm test` runs every suite to the end, even after one fails, and ends with a summary naming what failed (`tools/run-suites.mjs`); each suite's output is also in `test-results/<suite>.log`. A suite still running after 15 minutes is stopped and counted as failed (`--timeout <seconds>` changes that), so one that hangs doesn't hold the run. `npm test -- --parallel 2` runs two suites at once (any number; 1, one after the other, is the default and what CI does): every suite takes free ports and its own temporary folder, so what they share is the machine, and a timing check that passes alone can fail with more suites at once than it has CPUs to spare — a failure seen only that way is rerun alone before anything is read into it. With several at once, a suite's output is printed whole when it ends. The suites are listed longest first (`package.json`), so that with enough of them at once the run takes about as long as its longest suite, three minutes or so.

The suites run with the waits shortened ([design 2.25](design.md#225-the-tests-run-with-the-waits-shortened-the-code-with-the-waits-it-has)). The browser modules' fixed waits — the publisher's pause after a save, the time given to a public read before the worker is asked instead, the retries while the list is rebuilt — are multiplied by `$tw.cfworkerTestTimeScale`, which the test harness sets to 0.2 before each test page boots; nothing stored in a wiki can set it, so a deployed wiki has the waits as the modules say. The worker's fixed waits — the second purge after a list rebuild, the outdated mark's retry, a direct backup's retries — are multiplied by the `TEST_WAIT_SCALE` binding, which only the test setups give it. TiddlyWiki's own syncer, in the test pages, looks for work every 50 ms rather than 250 and retries an error after a second rather than five (`test/browser-harness.mjs`). The queue's delays are whole seconds in Cloudflare's API and aren't scaled; `BACKUP_RETRY_SECONDS` is 1 in the tests. A browser suite that fails leaves two more things there: `test-results/<suite>.requests.log`, every request its pages made, in order, with the time, the tab, the path and how it ended (answered, from the browser's cache, or given up on), and `test-results/traces/<suite>/<n>.zip`, a Playwright trace of each browser context — the test's actions and the page's console messages in time — opened with `npx playwright show-trace <file>`. `TRACE=1` keeps both for a passing suite too; `TRACE=full` adds screenshots and DOM snapshots to the traces (they slow the page down, so a timing check can fail with them). A passing suite removes the request log a failed run of it left, so what's in `test-results/` is the last run's.

| Command | What it runs |
|---|---|
| `npm run build` | Writes `worker.js`, and `seed/empty.html`, an empty TiddlyWiki with the TiddlyWeb plugin, from the installed `tiddlywiki` package (kept when it's already of that version; `node tools/build-wiki.mjs --force` rebuilds it). |
| `npm run check:build` | Fails, writing nothing, if `worker.js` isn't what the sources build (run it before committing, so `worker.js` is never out of date). |
| `npm run screenshot` | Writes `docs/admin-wiki.png`, the README's screenshot, from a wiki run through the test setup in Chromium (`tools/screenshot.mjs`): run it when the Cloudflare tab changes. |
| `npm run lint` | ESLint, with its recommended rules only: a name that doesn't exist (a function moved without its import, say), an unused one, an import assigned to. CI runs it first. |
| `npm run test:fast` | The seven suites that need no browser (a few minutes). |
| `npm run test:browser` | The eleven suites that run a real TiddlyWiki in Chromium. |
| `npm run test:suite -- <name>…` | Only the suites named, after a build: `npm run test:suite -- page-publish two-tabs`. |
| `npm run test:first` | A new wiki from an empty bucket, in Chromium. |
| `npm run test:bake` | Page serving and rebuilding, the published page, the Access check, the public address, the first visit. |
| `npm run test:integrity` | The tiddler list under failure: a save whose list update failed, a damaged or missing list rebuilt, a page build that fails, list writes out of order, draft-like titles. |
| `npm run test:repository` | The repository's guards, without the worker: `.gitignore`, `wrangler.toml`, what a deploy uploads, the scripts, the Miniflare pins, the docs' links and section references, the restore tool, the build's refusals; every suite wired into the scripts, the deployed bundle's size against the free plan, the version against the changelog. |
| `npm run test:r2` | R2 calls per kind of request, against a budget. |
| `npm run test:cpu` | CPU of the heaviest steps, a big plugin's save and backup, against a budget. |
| `npm run test:backup` | Queue backup against an imitation of GitHub's Contents API. |
| `npm run test:tabs` | Real TiddlyWiki in Chromium with several tabs, and a second browser for the conflicts; the tabs following each other. |
| `npm run test:plugins` | Real plugins in Chromium, on the admin site and a stand-in for the public site; a second admin tab following an install. |
| `npm run test:publish` | The page published from a real TiddlyWiki in Chromium. |
| `npm run test:lazy` | Loading a big wiki in Chromium, on both sites: what's shown first, the device's copy, the fill. |
| `npm run test:sync` | The full backup started from a real TiddlyWiki in Chromium, GitHub imitated. |
| `npm run test:private` | A private wiki, no public site, in Chromium; then a public site added. |
| `npm run test:offline` | Editing offline in Chromium, the network cut and restored. |
| `npm run test:login` | An expired Access session in Chromium, behind a stand-in for Access, the service worker in place: "log in again", not "offline". |
| `npm run test:cold` | Opening the wiki with no network, in Chromium: the service worker. |
| `npm run test:budget` | What reaches the worker per page load, counted behind a proxy, the service worker in place. |
| `npm run test:setup` | The setup check, against the public stand-in with Cloudflare's headers, GitHub and Cloudflare's API imitated. |

GitHub runs the same two groups, as two jobs side by side, for every pull request and every push to `main` (`.github/workflows/ci.yml`), after the lint and after checking that `worker.js` is what `src/` builds. One run per commit: a re-run of a commit's run never cancels another commit's, and an older commit's run goes on when a newer one is pushed. A job that fails, or is cancelled by its timeout, keeps its `test-results/` for a week (the run's page → *Artifacts*): the logs, and the request log and traces of each browser suite that failed or was stopped. Dependabot proposes the other packages' updates weekly, and the Actions', each once its release has been out for a few days (an npm package's three for a patch, a week for a minor, a month for a major; an Action's a week: a compromised release is usually found and pulled within days, and Workers Builds installs the dev dependencies with the credentials that deploy the worker; a fix for a known vulnerability isn't delayed); the `tiddlywiki` package it leaves alone ([operating 3.3](operating.md#33-updating-the-wiki-engine)).

## 6.1 Repository layout

```
├── README.md                 the front page: what it is, how it fits together, the quick start, the manual's chapters
├── CHANGELOG.md              what shipped, newest first, and what an update asks of you
├── CONTRIBUTING.md           how work on the repository happens: the principles, the process, the tests, where writing goes
├── AGENTS.md                 what an agent's environment adds to CONTRIBUTING.md, for any coding tool
├── CLAUDE.md                 points Claude Code at CONTRIBUTING.md and AGENTS.md
├── SECURITY.md               how to report a vulnerability, what's in scope, what the design counts on
├── CODE_OF_CONDUCT.md        the Contributor Covenant
├── LICENSE                   MIT
├── THIRD_PARTY_NOTICES.md    TiddlyWiki's licence, BSD, which the worker ships
├── worker.js                 GENERATED: the file you deploy (npm run build)
├── seed/empty.html           GENERATED, not committed: an empty TiddlyWiki with TiddlyWeb, what a new wiki starts from (setup 2.8), uploaded with the worker
├── tools/build-wiki.mjs      builds it from the tiddlywiki package (npm run build)
├── tools/restore.mjs         merges a clone of the backup into one file any TiddlyWiki imports (setup 2.4)
├── tools/run-suites.mjs      runs test suites, each to the end, one after the other or several at once (--parallel), with a summary (npm test); their output under test-results/, not committed
├── tools/screenshot.mjs      takes the README's screenshot from a wiki run through the test setup (npm run screenshot)
├── tools/release-notes.mjs   prints a dated block of the changelog, the release's notes (CONTRIBUTING, "Releases")
├── docs/
│   ├── setup.md              the manual, chapter 2: setting up
│   ├── operating.md          chapter 3: operating it
│   ├── troubleshooting.md    chapter 4: symptoms, causes, fixes
│   ├── limits.md             chapter 5: known limits
│   ├── development.md        chapter 6: this page
│   ├── reference.md          chapter 7: the documents the design relies on
│   ├── design.md             how the worker works, and why it's built this way
│   ├── roadmap.md            what's ahead, in order, and what's parked and why
│   ├── tests.md              what each test suite covers, the R2 calls per kind of request, the CPU budgets
│   ├── external-plugins.md   design notes for plugin files (design 1.8)
│   └── admin-wiki.png        GENERATED: the README's screenshot (npm run screenshot)
├── .github/
│   ├── workflows/ci.yml      runs the tests on GitHub for every pull request and push to main, keeping a failed job's test-results/
│   ├── dependabot.yml        dependency updates as weekly pull requests, each a few days after its release, the wiki engine excepted (operating 3.3)
│   ├── ISSUE_TEMPLATE/       the bug report form, and where questions and ideas go
│   └── PULL_REQUEST_TEMPLATE.md  the process as a checklist
├── src/
│   ├── worker/               the worker's source, one module per concern (below)
│   │   ├── index.js          the entry point: the Access and settings checks, the route table, the queue consumer
│   │   ├── bytes.js, tiddlers.js, storage.js, settings.js, access.js, http.js
│   │   │                     the shared pieces: UTF-8, what a tiddler is, every bucket key, every variable, Access, HTTP helpers
│   │   ├── layout.js         how a tiddler is stored, and how a save is read (design 1.2)
│   │   ├── cache.js          public-site purges (design 1.6)
│   │   ├── list.js           the tiddler list and its rebuild (design 1.2)
│   │   ├── plugins.js        plugin files (design 1.8)
│   │   ├── build.js          building the page (design 1.3)
│   │   ├── page.js           serving the page, and the page the admin wiki publishes (design 1.9)
│   │   ├── app.js            the wiki as an installable app: the manifest, the icons (design 1.12)
│   │   ├── setup.js          the setup check: each piece looked at from the worker (design 1.13)
│   │   ├── reads.js, saves.js  the handlers: status, list and objects; saves and deletes (design 1.4)
│   │   └── backup/           the GitHub backup: queue.js (the consumer, and the full backup's steps), github.js (the API), status.js (how backups go), sync.js (the full backup's requests)
│   ├── browser/              the browser modules, embedded into worker.js by the build (operating 3.17)
│       ├── lib.js            what they share: the sync adaptor, the public site's address, whether this is the admin site, titles in alerts (a TiddlyWiki library module)
│       ├── conflict-guard.js saves and deletes: the revision each is based on, conflicts, the flat layout
│       ├── list-sync.js      the tiddler list, loading (what's shown first, the device's copy, the fill), what isn't sent
│       ├── backup-alert.js   the alert while backups to GitHub keep failing (design 1.7)
│       ├── page-publisher.js the page published from the admin wiki (design 1.9)
│       ├── restore-import.js the backup's files dropped onto the wiki, imported with their tags (setup 2.4)
│       ├── control-panel.js  the control panel's Cloudflare tab: the setup check (operating 3.15), how backups go, the full backup (setup 2.4)
│       ├── outbox.js         every change kept on the device until the worker has it: editing offline (operating 3.11)
│       ├── cold-start.js     registers the service worker on the admin site (operating 3.13)
│       ├── device.js         the plugin's device tab: what this browser keeps, measured, kept or forgotten (operating 3.18)
│       ├── service-worker.js the service worker itself, served at /sw.js: the page, the core and plugin files, the status file and the last list kept for opening offline (operating 3.13)
│       └── plugin-readme.txt, plugin-settings.txt, plugin-device.txt  the admin plugin's three tabs, wikitext (operating 3.17, 3.18)
│   └── app/                  the app's default icons (PNG), embedded by the build (operating 3.16)
├── build.mjs                 inlines the modules into worker.js, in dependency order, with the browser modules embedded
├── eslint.config.js          the lint rules (npm run lint): names that don't exist, unused ones, an import assigned to
├── wrangler.toml             the worker's name, bindings and defaults: what Wrangler deploys, as it is; the settings are in the dashboard (setup 2.5)
├── package.json              build, lint and test scripts; the Deploy to Cloudflare button's descriptions of the bucket and the queue (cloudflare.bindings)
└── test/
    ├── first-visit.test.mjs  a new wiki from an empty bucket, in Chromium; the admin plugin's shadows
    ├── two-tabs.test.mjs     real TiddlyWiki in Chromium, several tabs and a second browser: conflicts between browsers, the tabs of one following each other, a restore
    ├── plugins.test.mjs      real plugins on the admin and public sites; a second admin tab following an install
    ├── page-publish.test.mjs the page published from a real TiddlyWiki
    ├── lazy-load.test.mjs    loading a big wiki on both sites: what's shown first, the device's copy, the fill; the fetch-ahead setting
    ├── backup-sync.test.mjs  the full backup from the admin wiki: the Cloudflare tab, the hint, the button, GitHub mirroring the wiki
    ├── private.test.mjs      a private wiki: everything from the worker, nothing purged, then a public site added
    ├── offline.test.mjs      editing offline: changes kept on the device, sent at the network's return or the next load; the draft pause setting
    ├── login-expired.test.mjs an expired Access session behind a stand-in for Access, the service worker in place: the probe, the dropdown, the login in another tab or by a reload
    ├── cold-start.test.mjs   opening the wiki with no network: the service worker, what it keeps and what it never keeps; the setup check from the tab; the network wait setting
    ├── budget.test.mjs       what reaches the worker per page load, behind a counting proxy, the service worker in place; the app's manifest as the browser fetches it
    ├── queue-backup.test.mjs queue backup against an imitation of GitHub, the full backup's steps
    ├── integrity.test.mjs    the tiddler list's integrity: a failed list update, a rebuild, a failed page build, draft-like and awkward titles
    ├── repository.test.mjs   the repository's guards: .gitignore, wrangler.toml, what a deploy uploads, the scripts, the Miniflare pins, the docs' links, the restore tool, the build's refusals
    ├── r2-ops.test.mjs       R2 calls per kind of request, against a budget
    ├── setup-check.test.mjs  the setup check: each piece in place or missing, the lines naming the setup guide's sections, with their links
    ├── cpu.test.mjs          CPU of a big plugin's save and backup, against a budget
    ├── r2-counter.mjs        test-only wrapper that counts the worker's R2 calls
    ├── browser-harness.mjs   the browser suites' shared setup (worker, public site stand-in, Chromium, helpers)
    └── bake.test.mjs         page serving and rebuilding, tiddler and file reads, the published page, the Access check, the public address, the first visit, the app, the admin plugin
```

The worker is written as ES modules, each importing only from the ones below it: the entry point, the handlers, the page, the list, the layout, then the shared pieces (`src/worker/index.js` lists the order). The build inlines them into `worker.js` in that order, so one file is deployed, which you can paste into the dashboard, with every comment kept; it refuses two modules that import each other, an import of something not exported, and a name declared twice. The tests run the built `worker.js` in Miniflare, and import a module's functions directly where they test one (`test/cpu.test.mjs`, the checks in `test/bake.test.mjs`).

The browser modules live in their own files so they can be read and edited as normal JavaScript, one per concern, each a TiddlyWiki module, sharing a library (`$:/cfworker/lib.js`) for what the sync modules have in common. The build embeds each file of `src/browser/` in `worker.js` as a string, in place of a placeholder named after it (`"__LIST_SYNC_SOURCE__"` for `list-sync.js`) in `src/worker/build.js`'s table of them, and refuses a file without its placeholder, or the reverse. The strings are written as JSON, so a module can contain any character, backticks and `${` included.


## 6.2 The tests

The tests run the real worker in Cloudflare's local runtime (workerd, through Miniflare) with a local R2 bucket and queue. Outgoing calls to GitHub and Cloudflare's API are answered by imitations, so nothing touches your accounts. Every suite takes free local ports, so they can run at the same time (`npm test` runs them one after the other, as CI does: eleven Chromium suites at once overload a small machine, and a timing check that passes in sequence can fail there — rerun such a suite alone before reading anything into it). The eleven browser suites share their setup, `test/browser-harness.mjs`: the worker, the stand-in for the public site, Chromium, and the helpers that wait for TiddlyWiki or record each tab's requests (marking the ones the browser answered from its cache, which never reached a server, and the ones it gave up on). Miniflare has no `max_concurrency` for a queue, and starts a second batch while one runs once messages pile up; `test/r2-counter.mjs` runs the batches one at a time, as Cloudflare does with the setting in `wrangler.toml`, so the backup suite's "never overlapped" check holds on a busy machine too. Two of Miniflare's own dependencies, `undici` and `sharp`, are pinned above the versions it declares (`overrides` in `package.json`; the changelog says why): the repository suite checks that the pins are what Miniflare gets, and says when to drop them — the day Miniflare's own declaration catches up.

What each suite covers, check by check — and the R2 calls each kind of request makes, the CPU budgets of the heaviest steps — is in [docs/tests.md](tests.md). To run the browser tests against your own wiki file, download `index.html` from the bucket and run `WIKI_HTML=/path/to/index.html npm run test:tabs` (or `test:plugins`).

## 6.3 Deploying a change

Edit `src/`, run `npm run build`, `npm run lint` and `npm test`, and push to `main` (through a pull request, so CI runs the tests too): Workers Builds deploys it ([setup 2.5](setup.md#25-the-worker)). Without it, `npx wrangler deploy`, or paste `worker.js` into the dashboard's editor. If anything in the plugin changed — a browser module, the service worker, a tab's text, a field, `package.json`'s version — the next admin page load rebuilds `baked.html`; a change to the worker's own code doesn't. If you changed how the page itself is built, also bump the number in front of `bakeVersion` (now `9-`), or existing pages keep the old format until something else rebuilds them; plugin files are only rewritten when their plugin changes, so after changing their format, delete `_plugins/` and open the admin wiki.

When bumping the engine (`package.json`'s `tiddlywiki`): if the new TiddlyWiki changes the filter in `tiddlers.json?filter=…`, add the new filter to `SKINNY_LIST_FILTERS`, or the public tiddler list won't be purged after saves (the tests show it).
