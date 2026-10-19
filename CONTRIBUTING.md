# Contributing

TiddlyWiki on a Cloudflare Worker, meant as a template anyone deploys without editing it. How it's used is the manual, the [README](README.md) and the pages under `docs/`; how it works and why, [docs/design.md](docs/design.md); where it's going and what's parked, [docs/roadmap.md](docs/roadmap.md). This file is how work on it happens. Read the roadmap before starting a step; an idea that isn't on it is best opened as an issue first, so it can be talked through before any code is written.

## Principles

Each with its reason and what enforces it. A change that crosses one needs the reason to have changed, and that written down (design 2).

- **It has to fit the free plan:** 100,000 worker requests a day, 10 ms of CPU a request, R2 and queue operations counted ([limits 5](docs/limits.md)). So a page load is 2 worker requests, tiddler contents come from the public site (from the worker once per device in a private wiki, which has none), and background tabs stop polling (`test/budget.test.mjs` counts what reaches the worker, behind a proxy, with the service worker in place — the browser makes requests of its own that no page sees; `test/first-visit.test.mjs`, `test/lazy-load.test.mjs` record every request a tab makes); a save neither parses nor copies a big plugin's text (`test/cpu.test.mjs`, a budget in ms); each kind of request has an R2 call budget (`test/r2-ops.test.mjs`); a backup is 3 queue operations and a waiting one as few as can be (`test/queue-backup.test.mjs` counts them). One more request, R2 call or queue operation per save or per load is a cost to justify in the PR, not a detail.
- **Secrets are worker secrets, never in `wrangler.toml`:** the file is deployed as it is, from a public repository. The repository suite refuses the file with `GITHUB_TOKEN` or `CF_API_TOKEN` set in it (`test/repository.test.mjs`); anything else, review.
- **Cloudflare runs the wiki; GitHub keeps the backup and the code:** one place to set up and understand. No GitHub Pages, no Action that builds anything.
- **One worker per wiki** ([setup 2.9](docs/setup.md#29-a-second-wiki)). Several wikis on one worker is parked (roadmap).
- **The queue's retries stay at 3, and there's no cron:** nothing runs while the wiki is untouched ([design 2.11](docs/design.md#211-backups-through-a-queue)); failures are retried by re-sending with a delay, not by a schedule.
- **Known limits ([limits 5](docs/limits.md)) lists real limits only,** things a user can hit, each with what to do about it. Not a to-do list.
- **Accepted, not handled:** a plugin titled `tiddlywikicore` would get the core file's key (`_plugins/tiddlywikicore.js`); nobody names a plugin that.

## How a change happens

1. **Plan first, in the user's words:** the README paragraph the change would add (what the user will experience) and the list of tests, by name — in an issue, or at the top of a draft pull request. Wait for a yes before writing code. A plan that reads as implementation detail is a sign the goal isn't clear yet.
2. **Tests first, run red:** write them, run them, see them fail for the right reason. A test never seen failing may not test the goal.
3. **Implement, then every suite** (below), then `npm run lint` and `npm run check:build` (`worker.js` is committed and must be what `src/` builds).
4. **The docs in the same PR:** the why in design 2 (the alternatives considered, and why they lost), the how in the manual's page it concerns (setup, operating, troubleshooting, limits), the what in `CHANGELOG.md` (with what an update asks of a user: an "Unreleased" entry), the roadmap updated (a finished step leaves it); the README's screenshot regenerated (`npm run screenshot`) if what it shows changed. A behaviour change without its design entry isn't finished.
5. **One PR at a time,** branched from `main`, merged by the owner; the next branches from the merge. Never push to `main`. Commits that only move code are their own commits, listed in `.git-blame-ignore-revs`.
6. **Ideas go to the roadmap's parked list** with the reason, not into the code of the current step. "While I'm here" is how drift starts.

A commit message says what changed, in plain words, after a conventional prefix (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`), and why in its body. The pull request template is this process as a checklist.

## AI-assisted contributions

Welcome, and how this repository was written, as the README says and the commit trailers show. Two conditions: you have read and understood what you submit, and can answer for every line of it; and the pull request says what was verified and how. A plan that reads as implementation detail, a test never seen failing, a doc left as it was: an assistant produces all three readily, and the process above is the check against them.

## Running the tests

The browser suites need Playwright's Chromium: `npx playwright install chromium` once, or `CHROMIUM_PATH` naming a Chrome of your own. While iterating, run only the suites the change touches: `npm run test:suite -- page-publish two-tabs` builds, then runs the named suites (`tools/run-suites.mjs`: each to the end, its output in `test-results/<suite>.log`, a summary, exit 1 if any failed). Run the full `npm test` once at the end, or leave it to CI on the pull request. `npm test -- --parallel <n>` runs that many suites at once: they are listed longest first, so a machine with CPUs to spare runs them all together in about the length of the longest, three minutes, while a machine with two CPUs bears two.

A browser suite that fails leaves `test-results/<suite>.requests.log` (every request its pages made, in order, how each ended) and `test-results/traces/<suite>/<n>.zip` (the test's actions and the page's console, in time: `npx playwright show-trace`); read those before guessing. Suites take free ports, so they can run together, but several Chromium suites at once overload a small machine, and timing checks fail that pass in sequence: rerun a failed suite alone before reading anything into it. The browser suites share `test/browser-harness.mjs`; the GitHub and Cloudflare APIs are imitations, so nothing touches an account. What each suite covers is in [docs/tests.md](docs/tests.md); the commands are in [development 6](docs/development.md).

## Releases

A release is a dated block of `CHANGELOG.md`. Entries collect under "Unreleased" as they merge; the pull request that dates the block also sets `package.json`'s version to that date (`2026-10-19` is `2026.10.19`, valid semver, and the repository suite checks the two agree), which the admin wiki's plugin then shows, followed by a build hash. Once that's merged, the tag and the GitHub release, with the block as its notes, are one command:

```bash
node tools/release-notes.mjs | gh release create "v$(node -p "require('./package.json').version")" --target main --title "$(node -p "require('./package.json').version")" --notes-file -
```

Nothing is built or uploaded: a wiki takes the release by syncing its copy of the repository (operating 3.1), as before.

## Where writing goes

| Kind | Where |
|---|---|
| What's ahead, in order, with "done when"; what's parked and why | `docs/roadmap.md` |
| What was decided, the alternatives, why | `docs/design.md` section 2 (section 1 is how it works; code comments cite "[design 1.4](docs/design.md#14-edit-conflict-protection)") |
| What shipped and what an update asks of a user | `CHANGELOG.md` |
| What it is, how it fits together, the names used throughout, the quick start | `README.md` |
| How to set up, operate, troubleshoot; the limits; how to run the tests | the manual's pages: `docs/setup.md`, `docs/operating.md`, `docs/troubleshooting.md`, `docs/limits.md`, `docs/development.md` |
| What each test suite covers; the R2-call and CPU budgets | `docs/tests.md` |
