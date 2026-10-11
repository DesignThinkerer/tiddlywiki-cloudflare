# Where this is going

What this project is for, what comes next and in what order, and what has been put aside and why. The decisions already taken, with the alternatives they beat, are in [design.md](design.md) section 2; what shipped is in the [changelog](../CHANGELOG.md). The rules for working on the code are in [CLAUDE.md](../CLAUDE.md).

## The goal

A TiddlyWiki anyone hosts on Cloudflare's free plan in about ten minutes, from this repository as it is: nothing edited in the fork, the settings in the dashboard, updates by syncing the fork. The wiki runs on Cloudflare only; GitHub keeps the backup (one commit per save) and the code. Behind Cloudflare Access it's private; given a domain, it's also a public site that costs no worker requests to read.

## Who it's for

1. **A public wiki** — a blog, documentation, notes you share — edited on a private admin site. What the project does today.
2. **A private notebook** — the admin site only, behind Access, no domain to own (done: README 2.1), edited offline when needed (steps 2 and 3 below).
3. **Both at once, or one then the other:** a private wiki that later gets a public site, by adding one setting, with nothing to migrate (done, design 2.15).

## Next, in order

Each step is one pull request, with its tests, its README section, its design entry and its changelog line. "Done when" is written as behaviour, and becomes the list of tests when the step starts.

### 1. The Deploy to Cloudflare button

**Why now:** the ten minutes. The button clones the repository into the user's GitHub account, creates the bucket and the queue from `wrangler.toml`, asks for the secrets and deploys; it needs the repository public.

**Done when:**
- `.dev.vars.example` names each secret with a line on where it comes from; `package.json` (`cloudflare.bindings`) describes the bucket and the queue, so the button's setup page explains them.
- A test checks that those files name every setting the worker reads, so a new setting can't be forgotten there.
- README, "With the button": both paths — private (done when the button finishes, plus Access), public (then the domain and the zone rules) — and what the button can't do for you (Access, the rules).
- Someone with a fresh Cloudflare account gets a working private wiki from the button without editing anything; a public one with the README's rules afterwards.
- The repository is public.

### 2. Editing offline, with the page open

**Why now:** the private audience. The device copy already holds every tiddler for reading; what's missing is saving without a network.

**Done when:**
- First, a short probe of TiddlyWiki's syncer without a network (what it retries, what it drops, what it shows), recorded in design 2 before anything is built on it.
- A save or a delete made offline is kept in a write-ahead outbox in the device store, in order; nothing is lost on reload or when the tab is closed.
- The wiki shows what's pending (how many changes, since when) and when it's back in sync.
- Back online, the outbox is sent in order through the conflict guard: a tiddler changed elsewhere meanwhile gets a conflict copy and an alert, as today.
- Tests: a browser suite with the network cut and restored under TiddlyWiki.

### 3. A service worker, for cold starts

**Why now:** after step 2 a page already open works offline; opening the wiki with no network still needs the page, the core file and the plugins from somewhere.

**Done when:**
- The admin wiki opens with no network, from a cache: page, core file, plugin files; the tiddlers from the device copy.
- Stale-while-revalidate, as TiddlyPWA does it: served from the cache, fetched again behind, the tab told when the page changed.
- A Cloudflare Access login page is never cached: only answers that are the worker's own are kept (the page's ETag, the `text/html` check on a navigation).
- Tests: a browser suite registering the service worker, then reloading offline.

### 4. A setup check, in the Cloudflare tab

**Why now:** the button leaves Access and the zone rules to the user; today a missing rule shows up as a `403` or a CORS error found by trial.

**Done when:**
- The tab reports each piece: Access on, the public site reachable at `PUBLIC_WIKI_URL` with the rewrite rule and the CORS header, backups set up, the queue bound; each missing one points at its README section.
- It runs on demand (a button), so it costs nothing at page load.

## Parked

Ideas with a reason to wait. Each says what it would be if it came back, so the reason can be checked rather than the idea rediscovered.

- **Static pages** (for search engines and readers without JavaScript, as tiddlywiki.com offers): rendered by the admin wiki, which already renders the page, into the bucket; not GitHub Pages, not an Action in the backup repository (the wiki stays on Cloudflare). Parked: not needed for the first audiences; the public wiki is a full TiddlyWiki already.
- **Several wikis on one worker:** today a second wiki is a second worker, from the same repository with Wrangler environments (README 2.9). The argument for one worker is one update for every wiki. If it comes back: a wiki per hostname, each with its own bucket or prefix and settings; a session's work, and it changes the storage layout, so it waits for a need.
- **A setup wizard** — a web page doing the setup through Cloudflare's API with a token — parked until the button proves insufficient.
- **Image and file upload** from the admin wiki into the bucket, served by the public site, with a tiddler pointing at the file (`_canonical_uri`). Parked: not asked for yet; noted when the missing features were reviewed.
- **Restore in reverse** — a tool writing the backup straight into the bucket. Parked: the import covers it (README 2.4), and it would need the tiddler list rebuilt afterwards.

## Keeping this file

A step that ships leaves this file in the same pull request: its reasoning goes to design 2, its line to the changelog. A new idea goes under Parked with its reason, not into the step under way. When the order changes, the "why now" lines change with it.
