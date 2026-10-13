# Working on this repository

TiddlyWiki on a Cloudflare Worker, meant as a template anyone deploys without editing it. How it's used is the [README](README.md); how it works and why, [docs/design.md](docs/design.md); where it's going and what's parked, [docs/roadmap.md](docs/roadmap.md). This file is how work on it happens. Read the roadmap before starting a step.

## Principles

Each with its reason and what enforces it. A change that crosses one needs the reason to have changed, and that written down (design 2).

- **It has to fit the free plan:** 100,000 worker requests a day, 10 ms of CPU a request, R2 and queue operations counted (README 5). So a page load is 2 worker requests, tiddler contents come from the public site (from the worker once per device in a private wiki, which has none), and background tabs stop polling (`test/budget.test.mjs` counts what reaches the worker, behind a proxy, with the service worker in place — the browser makes requests of its own that no page sees; `test/first-visit.test.mjs`, `test/lazy-load.test.mjs` record every request a tab makes); a save neither parses nor copies a big plugin's text (`test/cpu.test.mjs`, a budget in ms); each kind of request has an R2 call budget (`test/r2-ops.test.mjs`); a backup is 3 queue operations and a waiting one as few as can be (`test/queue-backup.test.mjs` counts them). One more request, R2 call or queue operation per save or per load is a cost to justify in the PR, not a detail.
- **Secrets are worker secrets, never in `wrangler.toml`:** the file is deployed as it is, from a repository that will be public. Nothing enforces it; review.
- **Cloudflare runs the wiki; GitHub keeps the backup and the code:** one place to set up and understand. No GitHub Pages, no Action that builds anything.
- **One worker per wiki** (README 2.9). Several wikis on one worker is parked (roadmap).
- **The queue's retries stay at 3, and there's no cron:** nothing runs while the wiki is untouched (design 2.11); failures are retried by re-sending with a delay, not by a schedule.
- **Known limits (README 5) lists real limits only,** things a user can hit, each with what to do about it. Not a to-do list.
- **Accepted, not handled:** a plugin titled `tiddlywikicore` would get the core file's key (`_plugins/tiddlywikicore.js`); nobody names a plugin that.

## How a change happens

1. **Plan first, in the user's words:** the README paragraph the change would add (what the user will experience) and the list of tests, by name. Wait for a yes before writing code. A plan that reads as implementation detail is a sign the goal isn't clear yet.
2. **Tests first, run red:** write them, run them, see them fail for the right reason. A test never seen failing may not test the goal.
3. **Implement, then every suite** (below), then `npm run lint` and `npm run check:build` (`worker.js` is committed and must be what `src/` builds).
4. **The docs in the same PR:** the why in design 2 (the alternatives considered, and why they lost), the how in the README, the what in `CHANGELOG.md` (with what an update asks of a user: an "Unreleased" entry), the roadmap updated (a finished step leaves it); the README's screenshot regenerated (`npm run screenshot`) if what it shows changed. A behaviour change without its design entry isn't finished.
5. **One PR at a time,** branched from `main`, merged by the owner; the next branches from the merge. Never push to `main`. Commits that only move code are their own commits, listed in `.git-blame-ignore-revs`.
6. **Ideas go to the roadmap's parked list** with the reason, not into the code of the current step. "While I'm here" is how drift starts.

## Running the tests

While iterating, run only the suites the change touches: `npm run test:suite -- page-publish two-tabs` builds, then runs the named suites (`tools/run-suites.mjs`: each to the end, its output in `test-results/<suite>.log`, a summary, exit 1 if any failed). Run the full `npm test` once at the end, or leave it to CI on the pull request. In the cloud environment Playwright needs `CHROMIUM_PATH=/opt/pw-browsers/chromium` (its own browser build isn't installed there).

A suite longer than one tool call allows (two-tabs, page-publish; `npm test` as a whole) goes in the background:

```bash
CHROMIUM_PATH=/opt/pw-browsers/chromium nohup npm run test:suite -- two-tabs page-publish > /tmp/suites.log 2>&1 &
```

then poll the log. A browser suite that fails leaves `test-results/<suite>.requests.log` (every request its pages made, in order, how each ended) and `test-results/traces/<suite>/<n>.zip` (the test's actions and the page's console, in time: `npx playwright show-trace`); read those before guessing. Suites take free ports, so they can run together, but ten Chromium suites at once overload the machine and timing checks fail that pass in sequence: rerun a failed suite alone before reading anything into it. The browser suites share `test/browser-harness.mjs`; the GitHub and Cloudflare APIs are imitations, so nothing touches an account.

## Where writing goes

| Kind | Where |
|---|---|
| What's ahead, in order, with "done when"; what's parked and why | `docs/roadmap.md` |
| What was decided, the alternatives, why | `docs/design.md` section 2 (section 1 is how it works; code comments cite "design 1.4") |
| What shipped and what an update asks of a user | `CHANGELOG.md` |
| How to set up, operate, troubleshoot; limits; how to run the tests | `README.md` |
| What each test suite covers; the R2-call and CPU budgets | `docs/tests.md` |
