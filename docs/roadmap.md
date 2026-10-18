# Where this is going

What this project is for, what comes next and in what order, and what has been put aside and why. The decisions already taken, with the alternatives they beat, are in [design.md](design.md) section 2; what shipped is in the [changelog](../CHANGELOG.md). The rules for working on the code are in [CLAUDE.md](../CLAUDE.md).

## The goal

A TiddlyWiki anyone hosts on Cloudflare's free plan in about ten minutes, from this repository as it is: nothing edited in the fork, the settings in the dashboard, updates by syncing the fork. The wiki runs on Cloudflare only; GitHub keeps the backup (one commit per save) and the code. Behind Cloudflare Access it's private; given a domain, it's also a public site that costs no worker requests to read.

## Who it's for

1. **A public wiki** — a blog, documentation, notes you share — edited on a private admin site. What the project does today; its setup by hand checked from the wiki (done: README 3, "Checking the setup").
2. **A private notebook** — the admin site only, behind Access, no domain to own, edited offline, opened offline, installed as an app (done: README 2.1 and 3).
3. **Both at once, or one then the other:** a private wiki that later gets a public site, by adding one setting, with nothing to migrate (done, design 2.15).

## Next, in order

Each step is one pull request, with its tests, its README section, its design entry and its changelog line. "Done when" is written as behaviour, and becomes the list of tests when the step starts.

### 1. The Deploy to Cloudflare button

**Why last:** the button is the front door, so it goes on once what's behind it is in place: the private wiki, offline editing, cold starts and the setup check (all done), each of which changes what the README's button section has to say. It clones the repository into the user's GitHub account, creates the bucket and the queue from `wrangler.toml`, asks for the secrets and deploys; it needs the repository public.

**Done when:**
- `.dev.vars.example` names each secret with a line on where it comes from; `package.json` (`cloudflare.bindings`) describes the bucket and the queue, so the button's setup page explains them.
- A test checks that those files name every setting the worker reads (the `env.` names in `src/worker`: eleven variables and secrets today, and the two bindings, which `wrangler.toml` declares), so a new setting can't be forgotten there. One named exception: `TEST_WAIT_SCALE`, which only the test setups give the worker (README 6), and no user sets.
- README, "With the button": both paths — private (done when the button finishes, plus Access), public (then the domain and the zone rules) — and what the button can't do for you (Access, the rules).
- Someone with a fresh Cloudflare account gets a working private wiki from the button without editing anything; a public one with the README's rules afterwards.
- The repository is public.

## Parked

Ideas with a reason to wait. Each says what it would be if it came back, so the reason can be checked rather than the idea rediscovered.

- **Static pages** (for search engines and readers without JavaScript, as tiddlywiki.com offers): rendered by the admin wiki, which already renders the page, into the bucket; not GitHub Pages, not an Action in the backup repository (the wiki stays on Cloudflare). Parked: not needed for the first audiences; the public wiki is a full TiddlyWiki already.
- **Several wikis on one worker:** today a second wiki is a second worker, from the same repository with Wrangler environments (README 2.9). The argument for one worker is one update for every wiki. If it comes back: a wiki per hostname, each with its own bucket or prefix and settings; a session's work, and it changes the storage layout, so it waits for a need.
- **A setup wizard** — a web page doing the setup through Cloudflare's API with a token — parked until the button proves insufficient.
- **Image and file upload** from the admin wiki into the bucket, served by the public site, with a tiddler pointing at the file (`_canonical_uri`). Parked: not asked for yet; noted when the missing features were reviewed.
- **Restore in reverse** — a tool writing the backup straight into the bucket. Parked: the import covers it (README 2.4), and it would need the tiddler list rebuilt afterwards.
- **A private site behind Access:** for a private wiki that has a domain, the bucket's custom domain protected by Cloudflare Access too, so the admin wiki reads tiddlers, the core file and plugin files through Cloudflare's cache with no worker request, as a public wiki does, while nobody else can. Needs the Access session shared across the two hostnames, reads sent with credentials (the CORS rule with `Allow-Credentials`), and the existing fallback to the worker for a read Access refuses. Open question before starting: whether a response Access allows is served from the cache rather than from R2 every time. Parked: a setup option for one audience. The private wiki and the cold start it waited for are done (checked 2026-10-17); what still comes first is the step above, and the open question wants an answer from a real zone before any code.

- **Batch reads from the worker** (a private wiki only): a `POST /batch` route answering a list of titles with the stored objects streamed as one JSON array, no parsing (each is a JSON document already), plugged into the list sync's read-ahead, which would fetch the next 50 or so in one request instead of 6 single ones. What it saves: worker requests, a thousand-tiddler first load on a new device going from 1,000 to about 20, and the same for catching up after a long offline stretch. What it doesn't: R2 reads (no multi-get: a batch of 50 is 50 reads), bandwidth, and anything on a public wiki, whose reads come from Cloudflare's cache without the worker. First step if it comes back: measure, with the CPU suite, how many R2 reads and how many bytes one request can pass through under the 10 ms budget; that number is the batch size, and decides whether it's worth having. Parked: a thousand requests once per device, against 100,000 a day, doesn't bite for one person, and `LoadAll = no` already cuts it to what's shown; worth it when a private wiki is used from many devices or by several people, or when someone hits the daily cap.

## Keeping this file

A step that ships leaves this file in the same pull request: its reasoning goes to design 2, its line to the changelog. A new idea goes under Parked with its reason, not into the step under way. When the order changes, the "why now" lines change with it.
