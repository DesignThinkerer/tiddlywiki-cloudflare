# Security policy

## Reporting a vulnerability

Report it privately, through GitHub: [*Report a vulnerability*](https://github.com/DesignThinkerer/tiddlywiki-cloudflare/security/advisories/new) on the repository's Security tab. Not as an issue: an issue is public, and would tell everyone before the wikis running from this repository can take the fix. You'll get a first answer within a week.

A fix ships as a pull request here, with its entry in [CHANGELOG.md](CHANGELOG.md); every wiki takes it by syncing its copy of the repository ([operating 3.1](docs/operating.md#31-updating-your-copy)), and an advisory is published once that's possible.

## What's in scope

The code in this repository: the worker (`src/worker`), the browser modules it puts in the page (`src/browser`), the build (`build.mjs`) and the tools (`tools/`).

Not in scope, with where to report instead: TiddlyWiki itself, at [its own repository](https://github.com/TiddlyWiki/TiddlyWiki5/security); Cloudflare's platform, Access, Workers, R2 or Queues, through [Cloudflare's disclosure programme](https://www.cloudflare.com/disclosure/).

## What the design counts on

Worth knowing before reporting, and before deploying:

- **Cloudflare Access in front of the admin site.** The worker refuses every request that didn't come through Access ([setup 2.6](docs/setup.md#26-cloudflare-access)); `ACCESS = off` is only honoured on a local address, for tests and local runs.
- **Secrets are worker secrets.** The GitHub token and the Cloudflare API token are entered in the worker's dashboard, never in `wrangler.toml`, which is deployed as it is ([setup 2.5](docs/setup.md#25-the-worker)). The GitHub token is a fine-grained one, limited to the backup repository ([setup 2.4](docs/setup.md#24-the-backup-repository-optional)).
- **A public site is public by design.** With a public site set up, everything saved in the bucket is readable by anyone at the bucket's custom domain the moment it's saved, drafts excepted (README, "Private, or public"). Without one, nothing in the bucket is reachable by anyone else.
- **A plugin is code.** A plugin installed in the admin wiki runs as JavaScript in every visitor's browser, on both sites: install what you trust.

## Supported versions

`main` only, which is what *Sync fork* gives a wiki ([operating 3.1](docs/operating.md#31-updating-your-copy)): the newest release — a dated block of [CHANGELOG.md](CHANGELOG.md), tagged on GitHub ([CONTRIBUTING.md](CONTRIBUTING.md), "Releases") — and whatever has merged since, under "Unreleased". A fix lands on `main` and in the next release; the changelog says what each update asks.
