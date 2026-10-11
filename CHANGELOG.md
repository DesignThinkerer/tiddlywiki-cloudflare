# Changelog

What changed, and what an update asks of you, newest first. Your worker is deployed from your copy of this repository: an update is GitHub's *Sync fork* (README 3, "Updating your copy"), and Workers Builds redeploys. Unless an entry says otherwise, nothing else is needed. The history before the repository went public is in git.

## Unreleased

- **Restoring from the backup** has a tool and a procedure (README 2.4): `node tools/restore.mjs <a clone of the backup>` writes `restore.json`, which you drag onto the admin wiki. The backup's files can't be dragged in as they are: TiddlyWiki's JSON import keeps only text fields, and a stored tiddler has its tags as a list, so every tag would be lost. Also for one tiddler, from any version in its history on GitHub.
- **`ACCESS = off` counts only for a request to a local address** (`localhost`, `127.0.0.1`): what the tests and `wrangler dev` use. On a deployed worker the switch now changes nothing. *If you had left it set on a deployed worker,* that worker refuses every request until you remove the variable and set Access up (README 2.6).
- Public by design, stated up front; the backup can't be checked out on Windows (README 5); this file.
- Tests: awkward titles (a comma, `%`, `#`, accents, emoji, slashes…) through every step; the restore round trip through TiddlyWiki's own import.

## 2026-10-11

- A tiddler or a file read from the worker answers `304` to a browser that has it (#13).
- README 2.4 links to GitHub's token form, filled in (#14).

## 2026-10-10

- **The empty wiki travels as a module of the worker, not as a static asset** (#12): a worker with static assets runs behind a router that doesn't pass Cloudflare Access's mark on, so the worker refused every request. *A worker set up before this with `ACCESS = off` as a workaround:* remove the variable.
- **`wrangler.toml` is deployed as it is** (#11): the settings live in the dashboard (variables or secrets), kept across deploys. *A copy with its own values in `wrangler.toml`:* move them to the dashboard (README 2.5) before syncing, or keep your edit.
