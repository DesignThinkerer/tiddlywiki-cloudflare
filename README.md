# TiddlyWiki on Cloudflare

Host your own [TiddlyWiki](https://tiddlywiki.com) on Cloudflare's free plan: a worker for editing, R2 for storage, a public read-only site served from the cache if you want one, and every save backed up to GitHub as its own commit.

- **The admin wiki,** at the worker's own address (`https://wiki-admin.<your subdomain>.workers.dev`, or a custom domain such as `admin.wiki.example.com`), is yours to edit, behind Cloudflare Access. A Cloudflare Worker speaks TiddlyWiki's own sync protocol (TiddlyWeb) and stores every tiddler in an R2 bucket.
- **The public wiki,** `https://wiki.example.com`, if you want one, is the same bucket served directly through its custom domain and Cloudflare's cache: read-only, and no worker involved, so visitors cost no worker requests. Without it, the wiki is private.

What the worker adds to a plain TiddlyWeb server:
- **Edit-conflict protection:** two tabs or devices editing the same tiddler can't silently overwrite each other; the later one gets a conflict copy and an alert.
- **A public copy that stays fresh:** after each change, exactly the cached URLs that changed are purged.
- **Plugins installed from the wiki work on both sites:** each gets its own file, which the page loads before TiddlyWiki starts.
- **A page TiddlyWiki writes itself:** the admin wiki renders the page with TiddlyWiki's own template and publishes it, so the title, the language and `$:/tags/RawMarkup…` tiddlers (link previews, a splash screen) work as in a single-file wiki. The core is a separate file cached for a year, which makes the page about 300 KB instead of 2.8 MB.
- **As few worker requests as it can:** a page load is 2 requests, tiddler contents come from the public site, and background tabs stop polling.
- **Backups through a Cloudflare Queue:** one commit per save, retried through outages and rate limits, with an alert in the admin wiki if they keep failing.

A new wiki starts by itself: the first time you open the admin site, the worker puts an empty TiddlyWiki in the bucket. To move an existing wiki in, drag its file onto the admin wiki.

**Private, or public.** Without a public site, the wiki is private: the admin site is the only one, behind Cloudflare Access, at the worker's own `workers.dev` address — no domain needed, and nothing in the bucket is reachable by anyone else. With a public site (the bucket's custom domain, one setting), every tiddler you save is readable there by anyone the moment it's saved (drafts are never saved, so they aren't): for a wiki you publish — a blog, documentation, notes you share. A private wiki can be made public later by adding that one setting; nothing moves.

**What you need:** a Cloudflare account (the free plan is enough) and a GitHub account (the worker is deployed from your copy of this repository; the backup goes to a repository too). For a public site, also a domain on that account (both sites are then hostnames of it).

This README covers the setup, operating the wiki, troubleshooting, the limits and the tests. How the worker works, and why it's built this way, are in [docs/design.md](docs/design.md).

---

## Contents

1. [How it fits together](#1-how-it-fits-together)
2. [Setting up](#2-setting-up)
3. [Operating it](#3-operating-it)
4. [Troubleshooting](#4-troubleshooting)
5. [Known limits](#5-known-limits)
6. [Development and tests](#6-development-and-tests)
7. [Reference](#7-reference)

---

## 1. How it fits together

```mermaid
flowchart LR
  subgraph Browsers
    T["Admin wiki tab<br/>TiddlyWiki + conflict guard<br/>+ page publisher"]
    V["Public visitor"]
  end
  T -- "page, tiddler list,<br/>saves and deletes, published page" --> W["worker<br/>the admin site<br/>(Cloudflare Access)"]
  T -- "tiddler contents, plugin files, core file<br/>(read-only, cached)" --> P["Public site<br/>wiki.example.com<br/>(R2 custom domain + cache)"]
  V --> P
  W <--> R2[("R2 bucket")]
  P --> R2
  W -- "one message per save/delete" --> Q[["Queue: wiki-backup"]]
  Q -- "one batch at a time" --> C["worker queue handler"]
  C --> GH[("GitHub repository")]
  W -- "purge changed public URLs" --> API["Cloudflare purge API"]
```

| Piece | Role |
|---|---|
| **The worker** (`worker.js`, built from `src/worker/`) | Serves the admin wiki: the page, the TiddlyWeb endpoints, saves and deletes with their conflict checks, cache purges. Writes a file for each plugin, and consumes the backup queue. |
| **Browser modules** (`src/browser/`) | TiddlyWiki modules the worker builds into the page. The conflict guard makes the browser say which version each edit is based on, handles conflicts, and sends saves in the layout the worker stores; the list sync keeps the tiddler list, loads what's shown first and keeps loaded tiddlers on the device, reads from the public site and cuts unneeded requests; the backup alert shows backups that keep failing; the page publisher, in the admin wiki, renders the page with TiddlyWiki's own template and sends it to the worker whenever it changes; the restore import turns the backup's files, dropped onto the wiki, back into tiddlers; the control panel's Cloudflare tab shows how backups go and starts a full backup; the outbox keeps every change on the device until the worker has it, so editing offline loses nothing; the cold start registers a service worker, so the wiki opens with no network. |
| **R2 bucket** | Holds everything: the wiki engine (`index.html`), the page both sites serve, the tiddler list, one JSON file per tiddler, one script per plugin, and TiddlyWiki's core file. |
| **Public site** | The bucket's custom domain. Cloudflare caches it, and nothing on it runs the worker. A private wiki has none: the worker serves the tiddler contents, the plugin files and the core file itself, and the device copy keeps a reload from asking for them again. |
| **Queue** `wiki-backup` | Holds one message per save or delete until it has been committed to GitHub. |
| **GitHub repository** | Version history: one commit per save, in `tiddlers/<title>.json`. |

---

## 2. Setting up

About ten minutes, in this order. Each step names what the next ones need.

### 2.1 Before you start

**A private wiki, or a public one.** A private wiki skips the public site: in 2.2 only the bucket, no custom domain; no zone rules (2.7); in 2.5 no `PUBLIC_WIKI_URL`, `CF_ZONE_ID` or `CF_API_TOKEN`. About five minutes. The steps marked *(public site only)* don't apply. Its first load on a new device reads every tiddler from the worker (5); after that, only what changed. To make it public later, do those steps then: the next page load takes the setting, and nothing moves.

The names, and where each goes. With the defaults, nothing in the repository needs editing: the worker is deployed as it is, and your settings are entered in the dashboard (2.5).

| Name | Default or example | Where it goes |
|---|---|---|
| the public site *(public site only)* | `wiki.example.com`, yours | the bucket's custom domain (2.2), the setting `PUBLIC_WIKI_URL` (2.5) and the zone rules (2.7) |
| the admin site | `wiki-admin.<your subdomain>.workers.dev` | the worker's own address, behind Access (2.6), allowed by the CORS rule (2.7); a custom domain instead, if you like (2.5) |
| the bucket | `wiki` | 2.2; `wrangler.toml` if you name it otherwise |
| the queue | `wiki-backup` | 2.3; `wrangler.toml` if you name it otherwise |
| the worker | `wiki-admin` | the name you give it in 2.5; `wrangler.toml` if you name it otherwise |

Make your own copy of this repository (a fork, or a copy from the template): Cloudflare deploys the worker from its `main` branch (2.5). `wrangler.toml` holds the bindings and the defaults above; its comments say what each is for. No secret goes in it, ever: the two secrets are entered in 2.5, with the settings.

### 2.2 The bucket and the public site

1. In the Cloudflare dashboard, under **R2**, create the bucket (`wiki`). Nothing to upload: the worker fills it on the first visit (2.8). For a private wiki, that's all: leave public access off, and **Public Development URL (`r2.dev`)** disabled.
2. *(public site only)* In the bucket's settings, turn on public access:
   - **Custom Domains:** connect `wiki.example.com`.
   - **Public Development URL (`r2.dev`):** keep it disabled. It's a second public address that skips the zone's cache and rules.
   - **CORS Policy:** leave it empty. A transform rule handles CORS instead (2.7).

With a custom domain, everything in the bucket is public through it, including every tiddler, the tiddler list and the page. That's intended: nothing private belongs in a public wiki's bucket. Secrets live in the worker's settings.

### 2.3 The backup queue

Under **Storage & Databases → Queues**, create the queue (`wiki-backup`). That's all: the deploy (2.5) binds the worker to it as its producer and consumer, with the settings in `wrangler.toml` (batches of 10, 5 seconds, one at a time, 3 retries). Don't lower the retries: the worker counts on them for its waits (design 1.7).

Until the worker is bound to the queue, it runs the same backup directly after each save, with a couple of quick retries but no long-term waiting; so the order of these steps doesn't matter.

### 2.4 The backup repository (optional)

- **A repository of its own** for the backup, one per wiki, private if you like. Files go in `tiddlers/`. Never use the repository the worker is deployed from: its token would let anyone who got it change the worker's code.
- **A fine-grained personal access token** limited to that repository, with *Contents: read and write*. [This link](https://github.com/settings/personal-access-tokens/new?name=wiki+backup&description=One+commit+per+save+into+the+backup+repository+%28tiddlywiki-cloudflare%2C+README+2.4%29&expires_in=366&contents=write) opens GitHub's form with the name, the permission and the longest expiry the form allows (a year) filled in; what's left is *Repository access → Only select repositories* → the backup repository, then *Generate token*. You'll store it as the `GITHUB_TOKEN` secret (2.5). When it expires, the admin wiki shows the backup alert (`Bad credentials`): make a new one the same way and replace the secret.

Without a repository and a token, the worker skips backups.

**A wiki that already has content** when backups are set up — an imported wiki, say — has nothing on GitHub until a **full backup** runs: the admin wiki reminds you once, and the button is in the Control Panel → Saving → **Cloudflare** tab, *Back up everything to GitHub*. It makes GitHub mirror the wiki: every stored tiddler GitHub doesn't have, or has differently, is committed, and files of tiddlers no longer in the wiki are removed; run again, it changes nothing. It runs in the backup queue, without the tab, at GitHub's pace (about 500 commits an hour), and the tab shows its progress (as of its last minute's refresh, or *Refresh*). Run it once after setting backups up, after a restore (below), after putting a tiddler in the bucket by hand, or in any doubt.

**Restoring from the backup:** the backup is the wiki, one file per tiddler, so a wiki can be rebuilt from it in a new bucket or a new account: do 2.2 to 2.8 with an empty bucket, clone the backup, and drag its files onto the admin wiki, like an existing wiki's file (2.8). The admin wiki knows these files: TiddlyWiki's own JSON import keeps only text fields, and a stored tiddler has its tags as a list, so dropped onto any other TiddlyWiki they would lose every tag; the admin wiki's restore-import module turns them back into tiddlers, tags included, without the old revision, bag and recipe. Every tiddler is then saved again, plugins included, each created anew and backed up. A thousand tiddlers take a few minutes to save and, at GitHub's pace, a couple of hours to commit (5). For a whole clone, rather than dropping a thousand files, `node tools/restore.mjs <the clone>` (from a clone of this repository, Node 22) merges them into one `restore.json`, which you drag instead; it also makes a file any TiddlyWiki imports, and a single-file wiki out of a backup, for reading it anywhere: `npx tiddlywiki@5.4.1 wiki --init empty && npx tiddlywiki@5.4.1 wiki --load restore.json --build index` makes `wiki/output/index.html`. To get back one tiddler, or one of its past versions: download its file from GitHub (its history has every version) and drop it onto the admin wiki.

### 2.5 The worker

The worker is deployed from your repository by Cloudflare's **Workers Builds**: every push to `main` builds `worker.js` and deploys it, with the bindings and settings from `wrangler.toml`.

1. Under **Workers & Pages**, create the worker from your repository (**Create → Import a repository**, or for a worker that already exists, its **Settings → Builds → Connect**). Cloudflare's GitHub app needs access to that repository. Name the worker `wiki-admin`: the name must be the `name` in `wrangler.toml`.
2. The build settings:
   - **Production branch:** `main`.
   - **Build command:** `npm run build`. It writes `worker.js` and `seed/empty.html`, the empty wiki a new bucket starts from, which the deploy uploads with the worker (as a text module of it: `wrangler.toml`).
   - **Deploy command:** the default, `npx wrangler deploy`.
   - **Builds for non-production branches:** off. A branch's preview would use the real bucket and queue.
   - **Build watch paths:** include only `src/*`, `build.mjs`, `tools/*`, `package.json`, `package-lock.json` and `wrangler.toml`, so a change to the README, or anything else, doesn't deploy.
3. **The settings and the secrets,** under the worker's **Settings → Variables and Secrets**. A deploy keeps them all (`keep_vars` in `wrangler.toml`), so nothing of yours is in the repository. The settings can be plain variables or secrets, as you prefer; the two tokens must be secrets — in the dialog, choose the type *Secret*: its default, *Text*, shows the value to anyone who opens the settings.

   | Name | What |
   |---|---|
   | `PUBLIC_WIKI_URL` | *(public site only)* the public site's address, `https://` and the bucket's custom domain (2.2), nothing after the hostname. The page loads its plugin files and TiddlyWiki's core from it, and the admin wiki reads tiddlers from it. **Leave it out for a private wiki:** the worker then serves all of that itself. Set wrongly — an address that isn't a site's, or the worker's own — every request answers `500` saying so. |
   | `CF_ZONE_ID` | *(public site only)* the zone ID of the public site's domain (on the domain's overview page), for the public site's purges |
   | `CF_API_TOKEN` | *(public site only) secret:* an API token (**My Profile → API Tokens**) with *Zone → Cache Purge* on that zone. Without it and `CF_ZONE_ID`, no purges. |
   | `GITHUB_REPO`, `GITHUB_BRANCH` | `owner/repo` of the backup repository (2.4), and its branch (default `main`) |
   | `GITHUB_TOKEN` | *secret:* the token of 2.4. Without it and `GITHUB_REPO`, no backups. |
   | `CONFLICT_GUARD` | `off` builds the page without the browser modules (3). (The wiki's own settings for those modules live in the plugin's settings tab, 3.) |
   | `BACKUP_RETRY_SECONDS` | the first wait before a failed backup is tried again (default 60). |
   | `BACKUP_ALERT_MINUTES` | how long backups have to keep failing before the admin wiki shows it (default 60, design 1.7). |
   | `ACCESS` | `off` lets requests through that didn't come through Cloudflare Access (2.6), for the tests and local runs: only requests to a local address (`localhost`, `127.0.0.1`), so on a deployed worker it changes nothing. |

   Saving a variable deploys it at once; the first page load after that uses it.
4. The first deploy runs when you push, or at once if the dashboard offers it. The worker then answers at `https://wiki-admin.<your subdomain>.workers.dev` (your account's `workers.dev` subdomain is shown under Workers & Pages); that's the admin site, once Access protects it (2.6).

**A custom domain for the admin site** (`admin.wiki.example.com`, say) instead of the `workers.dev` address, if you have a domain: add it under the worker's **Settings → Domains & Routes** (Cloudflare creates the DNS record), and use it in the CORS rule (2.7) and in Access (2.6). Or put it in `wrangler.toml` (the `routes` block in comments) if you'd rather have it in the repository; then set `workers_dev = false` there, so the worker has one address.

**Without Workers Builds,** two other ways work: `npx wrangler deploy` from your computer, after `npm install` and `npm run build`, with the same `wrangler.toml` and the settings in the dashboard; or pasting `worker.js` into the dashboard's editor, in which case you add the bindings of `wrangler.toml` by hand in the worker's settings too, and the empty wiki (2.8), since a pasted worker carries no asset.

### 2.6 Cloudflare Access

Protect the worker with **Worker Access → All traffic** (production and preview URLs) and a policy allowing you (your Cloudflare account's e-mail, say). This covers the worker's `workers.dev` address, a custom domain, and its preview URLs, which `wrangler.toml` turns off anyway. Requests Access blocks never reach the worker, so they cost no quota.

The worker has no login of its own, so it relies on this, and checks it: Cloudflare marks a request that came through Access (`ctx.access`), and the worker answers `403` to any request without that mark, before reading or building anything. (That mark never reaches a worker deployed with static assets, which run behind a router of Cloudflare's; this worker has none, which is why the empty wiki travels as a module of it, 2.5.) So if the Access application is missing, or covers another hostname than the one a request came to, the wiki is closed rather than open; the `403` says what to do. Only the tests and local runs, where there is no Access, switch the check off with `ACCESS = off`, and the switch counts only for a request to a local address (`localhost`, `127.0.0.1`): left on by mistake on a deployed worker, it opens nothing.

### 2.7 The zone's rules *(public site only)*

Under your domain, in the dashboard. Each rule names the public hostname, so `/` on other hostnames of the zone isn't rewritten, and nothing else is cached by these rules.

**A URL rewrite** (Rules → Transform Rules → Rewrite URL), so the public site opens on the built page:
- **When:** `http.host eq "wiki.example.com"` and `http.request.uri.path eq "/"`
- **Then:** rewrite the path to `/baked.html`

**Cache rule "Cache public wiki":**
- **When:** `http.host eq "wiki.example.com"`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** ignore the cache-control header and use a TTL. R2 sends none, and every change made through the worker is purged right away. One day is a safe default; longer works too, but a missed purge or a file uploaded to R2 by hand then stays stale that long.
- **Browser TTL:** override with something short, for example 5 minutes. Purges can't reach visitors' browsers, and without this Cloudflare's default of 4 hours applies.
- **Serve stale content while revalidating:** off.
- **Cache key:** the defaults. The query string must stay in the key, because purges target exact URLs (design 1.6).

**Cache rule "Cache plugin files"**, placed *after* the one above (when several rules match, the last one wins):
- **When:** `http.host eq "wiki.example.com"` and `starts_with(http.request.uri.path, "/_plugins/")`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** use the cache-control header if present, Cloudflare's default if not. Plugin files carry `Cache-Control: public, max-age=31536000, immutable`.
- **Browser TTL:** respect origin
- **Cache key:** the defaults. The query string (`?v=<revision>`) must stay in the key: it's what makes each version a new URL.

Plugin files are never purged: each version has its own URL (design 1.8). Without this rule they follow "Cache public wiki", which still works, but browsers re-check them every few minutes. TiddlyWiki's core file, `_plugins/tiddlywikicore.js`, is under the same path, with the same caching.

**Cache rule "Cache status file"** (optional), also placed after "Cache public wiki":
- **When:** `http.host eq "wiki.example.com"` and `http.request.uri.path eq "/status"`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** ignore the cache-control header and use a TTL of 7 days (the file never changes)
- **Browser TTL:** override with 7 days

Public tabs ask for `/status` at every page load, before the tiddler list. With this rule a visitor's browser asks once a week; without it, "Cache public wiki" applies and it asks again after a few minutes.

**Response header transform rule "CORS for the admin wiki"** (Rules → Transform Rules → Modify Response Header):
- **When:** `http.host eq "wiki.example.com" and (starts_with(http.request.uri.path, "/recipes/") or starts_with(http.request.uri.path, "/_plugins/"))`
- **Then:** set the static header `Access-Control-Allow-Origin` to the admin site's origin, `https://wiki-admin.<your subdomain>.workers.dev` (or `https://admin.wiki.example.com` with a custom domain; no trailing slash)

This lets the admin wiki read tiddler contents from the public site (design 1.5, 2.9), and keep the core and plugin files for opening offline (section 3). Without it everything still works online, but every tiddler is fetched through the worker, and the files aren't kept: a rule set before the `/_plugins/` path was part of it needs that path added.

A "Bypass cache" rule for the admin hostname is optional: Cloudflare never caches responses a worker generates itself.

### 2.8 The first visit

Open the admin site (`https://wiki-admin.<your subdomain>.workers.dev`, or your custom domain). Access asks you to log in, then the worker puts an empty TiddlyWiki in the bucket as `index.html` (the engine; your content lives in the tiddler files) with the public site's `status` file (written for a private wiki too, for the day it gets a public site), builds the page, and the wiki opens. That first load also publishes TiddlyWiki's core file and the page, for both sites. With a public site, open `https://wiki.example.com` to see it. Then Control Panel → Saving → Cloudflare → *Check the setup* looks at each piece (Access, the public site's rules, backups, the queue, purges) and names the README section for one that's missing (3, "Checking the setup").

**An existing wiki:** drag its `.html` file onto the admin wiki. TiddlyWiki's import saves every tiddler, plugins included, and each goes to R2 and to the backup. Don't upload your wiki as `index.html` instead: TiddlyWiki deletes, at the first sync, every tiddler the page came with that the server doesn't list, so the content would vanish from view, and the file itself would be public.

**A pasted worker** (`worker.js` alone, without the empty wiki, 2.5): upload `seed/empty.html` (made by `npm run build`) to the bucket as `index.html`, and a file `status` with this content, the TiddlyWeb status for the public site (without it, public tabs don't know the recipe and can't load the tiddler list):

```json
{
  "username": "GUEST",
  "read_only": true,
  "anonymous": true,
  "logout_is_available": false,
  "space": {
    "recipe": "default"
  }
}
```

### 2.9 A second wiki

A second wiki is a second worker with its own bucket, queue, settings and, if public, its own public site: steps 2.2 to 2.8 again with other names. From one repository, Wrangler environments do it: an `[env.notes]` section in `wrangler.toml` with that wiki's `name`, bucket and queue (and route, with a custom domain), deployed with `npx wrangler deploy --env notes` (as the deploy command of a second Workers Builds project, or from your computer); its settings go in that worker's dashboard like the first one's. The zone rules are per hostname, so each wiki gets its own set, and `CF_ZONE_ID` and `CF_API_TOKEN` can be shared. The free plan's limits (5) are per account, whichever way the wikis are deployed.

---

## 3. Operating it

**Deploying a change:** edit `src/`, run `npm run build`, `npm run lint` and `npm test`, and push to `main` (through a pull request, so CI runs the tests too): Workers Builds deploys it (2.5). Without it, `npx wrangler deploy`, or paste `worker.js` into the dashboard's editor. If anything in the plugin changed — a browser module, the service worker, a tab's text, a field, `package.json`'s version — the next admin page load rebuilds `baked.html`; a change to the worker's own code doesn't. If you changed how the page itself is built, also bump the number in front of `bakeVersion` (now `9-`), or existing pages keep the old format until something else rebuilds them; plugin files are only rewritten when their plugin changes, so after changing their format, delete `_plugins/` and open the admin wiki. Reload any open admin tabs: tabs opened before a change keep the old modules, and tabs older than the modules have no conflict protection.

**Updating your copy:** your worker is deployed from your copy of this repository, which this one keeps changing. To take an update: on GitHub, *Sync fork* on your fork (or `git pull` from this repository, added as a remote, for a copy made from the template); Workers Builds redeploys, and the next admin page load rebuilds the page. Nothing in the repository holds your values (`wrangler.toml` is deployed as it is, the settings live in the dashboard, 2.5), so an update never conflicts with them. [CHANGELOG.md](CHANGELOG.md) lists, for each change, anything to do by hand — a new setting, a new zone rule; unless it says so, nothing is.

**A full backup** (Control Panel → Saving → Cloudflare): whenever GitHub might not mirror the wiki — backups set up after content existed, a restore, a tiddler put in R2 by hand, a backup that failed for good and was fixed. It commits only what differs and removes files of tiddlers that are gone, so running it in doubt costs little: a step of about 20 tiddlers every few seconds, 3 queue operations a step, and GitHub calls only for what's missing (design 1.7). If the tab says the last one stopped without finishing, start it again.

**Updating the wiki engine:** a new TiddlyWiki version comes with the repository: `package.json` pins the `tiddlywiki` package, and the worker ships the empty wiki built from it. To move your wiki to it, update your copy (*Sync fork*, or the pull request that bumps the version, so the tests run on it), let Workers Builds deploy, then open the admin wiki: Control Panel → Saving → Cloudflare shows *Engine: TiddlyWiki 5.4.1 — the worker ships 5.4.2* and a button, *Update the engine*. It asks once more, in the tab, saying what goes with the old engine; then the worker replaces `index.html` with the one it ships, and the next page load builds the page from it, publishes the core file and the page for the new version and purges the public copy (design 1.15). Your tiddlers, the plugins you installed and the published page aren't touched. What goes: a plugin that came with the current engine and wasn't installed from the wiki — one you baked into an `index.html` you uploaded yourself, say. A plugin that came with the engine and that you updated from the library keeps your version, which may now be older than the new engine's: delete yours to take the engine's ("Plugins", below). When the versions match, the tab says so and shows no button. Deleting `index.html` in R2 and opening the admin wiki does the same, and uploading an `index.html` of your own (an empty TiddlyWiki with the TiddlyWeb plugin) still works: the tab then shows its version. If a TiddlyWiki upgrade changes the filter in `tiddlers.json?filter=…`, add the new filter to `SKINNY_LIST_FILTERS`, or the public tiddler list won't be purged after saves (the tests show it). Plugins installed through the wiki override the copies in `index.html`: after an upgrade, update the version in the plugin library's URL (`$:/config/OfficialPluginLibrary`) and update your plugins from its Updates tab.

**Plugins:** install, update, disable or delete them from the wiki (drag and drop, the plugin library, the Control Panel). When TiddlyWiki asks you to reload, wait until the save has finished, then reload. The public site gets the same plugins. As in a single-file wiki, updating a plugin that came with `index.html` (a theme from the plugin library, say) replaces it, and deleting it afterwards removes it. To get `index.html`'s version back: in R2, delete `_page/shell.html` and `baked.html`, then open the admin wiki. The page is built from `index.html` again, and that load publishes it. Any other plugin from `index.html` you deleted comes back too.

**The published page:** nothing to do. After this version is deployed, the first admin page load publishes the core file and the page; after that, every save that changes the page publishes it (design 1.9). If a raw markup tiddler stops the wiki from starting:
1. In R2, delete `_page/shell.html` and `baked.html`.
2. Open the admin wiki: the page is built from `index.html` again.
3. Fix or delete the tiddler in that tab before reloading. The tab publishes the broken page again once loaded, but it keeps running the page it has, and saving the fix publishes the fixed one.

**If a plugin breaks the page** (the wiki doesn't start), on both sites:
1. In R2, delete `_plugins/<plugin title>.js`.
2. Purge it from Cloudflare's cache: Caching → Configuration → Purge Cache, either the exact URL with its `?v=` (in the page's source) or everything.
3. Hard-reload the admin wiki (Ctrl+Shift+R). It starts without the plugin. TiddlyWiki may ask for a reload; ignore it.
4. Delete or disable the plugin in the Control Panel and wait for the save. The page is rebuilt without it, or with it disabled.

If the page is rebuilt before step 4 (by a deploy, or by saving another plugin, a startup action, `$:/theme` or a disable flag), the file is written again; delete it again.

**A plugin with raw markup** (one with a tiddler tagged `$:/tags/RawMarkup…`) is in the page as well as in its file (design 1.9), so deleting the file isn't enough, and a page built again writes the file again while the plugin is stored. Remove the plugin itself, in R2:
1. Delete `recipes/default/tiddlers/<plugin title>` and `_plugins/<plugin title>.js`, then `recipes/default/tiddlers.json`, `_page/shell.html` and `baked.html`.
2. Purge everything from Cloudflare's cache.
3. Open the admin wiki. The worker rebuilds the tiddler list from the stored tiddlers (design 1.2) and the page from `index.html`, both without the plugin, and the admin wiki then publishes its page. The GitHub backup still has the plugin (`tiddlers/<plugin title>.json`), to install again once fixed.

**Checking the modules are active:** in the admin wiki's browser console, `$tw.syncadaptor.conflictGuardInstalled` should be `true` (the conflict guard), and `$tw.syncadaptor.cfworkerBackupAlert` too (the backup alert, which runs after the list sync).

**Log lines** (the worker's logs, under its Logs tab in the dashboard):

| Line | Meaning |
|---|---|
| `[Backup] '<title>' not backed up yet (<reason>); retrying in Ns` | A GitHub call failed. It will be retried, and nothing is lost. |
| `[Backup] Could not queue '<title>', backing up directly` | The queue was unavailable, so the backup ran directly. |
| `[Backup] '<title>' could not be backed up` | A direct backup (no queue bound, or the queue unavailable) failed 3 times. That version isn't on GitHub. |
| `Cache purge failed (<status>)` | The purge API refused; check the `CF_API_TOKEN` permission. |
| `[Manifest] Write conflict detected, retrying` | Two saves updated the tiddler list at once. This is normal and retried automatically. |
| `The tiddler list can't be read: rebuilding it from the stored tiddlers` | The list was damaged, and the worker is rebuilding it (design 1.2). The damaged copy is in `_repair/`. |
| `Tiddler list rebuilt: <n> tiddlers` | The rebuild is complete. |
| `Rebuilding the tiddler list: <key> is not a readable tiddler, left out` | That object in R2 isn't valid JSON. It was already unreadable for the wiki. |
| `Rebuilding the tiddler list: <key> isn't stored the way the worker stores tiddlers, left out` | An object in an older layout, under a URL-encoded key, or uploaded by hand (design 1.2). Save the tiddler again from a wiki that has it, or upload it in the flat layout with its metadata (design 1.2); an object under a URL-encoded key can be deleted. |
| `Failed to rebake HTML` | Building `baked.html` failed; the last page built is served instead (or `index.html` if there is none). A list being rebuilt over several requests also shows this line until it's done. |

**Manual purge:** Cloudflare dashboard → Caching → Configuration → Purge Cache. Use it if something on the public site looks stuck, for example after uploading files to R2 by hand.

**Loading a big wiki:** a tab gets the tiddler list (every field but the text) and loads the tiddler it shows first; the rest fills in in the background, several at a time, only while the tab is visible, so that search and backlinks work on everything. Loaded tiddlers are kept in the browser (IndexedDB, like its cache: clearing the site's data removes them), so the next page load fetches only what changed since, on any device. To skip the fill, untick it in the plugin's settings (below; it takes effect at the next page load): each tiddler then loads the moment it's shown, and nothing else is fetched, but the sidebar's text search, backlinks and the Missing and Orphans lists only see tiddlers the tab has loaded (titles, tags and fields are always searched). Design 1.5.

**Editing offline:** with the admin wiki open, keep editing without a network. TiddlyWiki retries every few seconds; the moment the connection is back, everything reaches the worker, each save checked for conflicts as usual. Its *Network Error* alert isn't shown on the admin wiki (it would be back at every retry): the cloud icon turning red and its dropdown say it, below. TiddlyWiki's other alerts — a save the worker refuses, say — show as always. What this setup adds is that nothing is lost in between: every change is written to this device at once (the same store that keeps your tiddlers for reading), so a reload, a crash or a closed tab while offline keeps it, and the next time the wiki opens on this device it sends it — a tiddler changed elsewhere meanwhile gets a conflict copy, as online. If the browser refuses to store a change — no room left, or storage unavailable in that window — the dropdown says so instead of promising: the change then lives only in that tab until it's sent, so keep the tab open. A draft is kept there too, never sent to the worker: after a reload, TiddlyWiki lists it at the top of the page, with the text as you left it. (What another tab of the same browser still holds — a draft being typed, a change it's still sending — is left to that tab: a tab you open meanwhile doesn't take it over.) The cloud icon in the sidebar turns red while something is unsaved, as it always has; click it for how many changes are waiting, since when, and whether you're offline. What waits on a device is sent from that device: another device doesn't see it until then. Opening the wiki *with no network at all* still needs the page from a server. Design 1.10.

**Opening the wiki offline:** after one visit online, the admin wiki opens without a network. A service worker the admin site registers keeps the page, TiddlyWiki's core file, the plugin files, the status file and the last tiddler list; the tiddlers come from the device copy. It fills its cache as soon as it's installed, at that first visit (two requests to the worker, once per device), and at every page load online it keeps the files the page refers to, so a file missing from the cache — a browser clearing space, a copy that didn't finish — is back at the next load online. Online, nothing changes: the page is always asked from the worker first, so an update's new page, or Cloudflare Access asking you to log in again, shows as before — the cache only answers when the network doesn't. Offline, only what this device has loaded is there: a tiddler never opened on it stays empty. The tiddler list is the last one this device kept, which can be older than its last saves, so a list from the cache can only add: the wiki completes it with what the device holds and removes nothing while offline — not from the tab, not from the device copy, not from the outbox; what was deleted elsewhere meanwhile goes at the network's return, when a real list comes. A change made then waits in the outbox like any other. If your Access session expires while you're offline, reload once the network is back to log in again. For a public wiki, the core and plugin files are kept for offline use only with the CORS rule (2.7) in place, its `/_plugins/` path included; without it they load as before, online only, and with no network and no copy of the core file on the device the page says so in a line. The admin wiki asks the browser to keep this site's storage (the service worker's cache, the device copy, the outbox) rather than clear it when short of space; browsers grant that by their own rules (Chrome to a site used often, installed or bookmarked; Firefox asks you), and the cloud icon's dropdown says when it isn't granted and a change waits. Design 1.11.

**Checking the setup:** Control Panel → Saving → Cloudflare → *Check the setup* asks the worker to look at each piece and lists what it found, one line each, a missing or wrong one saying what was found and naming the README section that fixes it. The pieces: Access protecting the admin site; the public site answering at `PUBLIC_WIKI_URL` with the page (the rewrite rule), allowing the admin site to read tiddlers from it and to keep the core and plugin files for offline use (the CORS rule, each of its two paths checked), and cached (the cache rules, optional: reported, never a failure); backups set up, GitHub accepting the token for the repository and its branch, and the backup queue bound; purges allowed, tested by purging the public site's `status` file (optional, like the zone settings); and, in this browser, the service worker in place with the core file kept, so the wiki opens offline. A private wiki's public-site lines say there's nothing to check. It runs only when you click — one request to the worker, which makes a few of its own to the public site, GitHub and Cloudflare — so it costs nothing at page load. Nothing says these things otherwise: the page's own requests work without the CORS header, and a missing rewrite rule shows only to visitors. Design 1.13.

**Installing the wiki as an app:** the admin wiki is a web app the browser can install — Chrome shows an install button in the address bar, Android offers "Add to Home screen", on iOS use Safari's share menu — and it then opens in its own window, without the browser's bars, under its own icon and the wiki's title. Installed, Chrome also keeps the site's storage persistent (the device copy, the outbox, the service worker's cache) without being asked. The icon is a plain one; to use your own, upload `_app/icon-192.png` and `_app/icon-512.png` to the bucket, square PNGs of those sizes (the worker puts the defaults there at the first page build, so you'll find them). Nothing to set up: the page carries the app's manifest, which the worker serves, with the wiki's title as the app's name. The public site can be installed too, as a read-only app; it has no service worker, so it needs the network to open. Design 1.12.

**The plugin and its settings:** the admin wiki's modules travel as a plugin, `$:/plugins/cfworker/admin`, listed in Control Panel → Plugins with the worker's version: the worker puts it in every page it builds, so it always matches the worker, and never stores it. Its parts are shadow tiddlers, out of search and out of syncing; a part you edit is an override, as with any plugin — it stays through the worker's updates, the dialog marks it, delete it to get the worker's part back. The plugin's *settings* tab holds the wiki's own settings (tiddlers under `$:/config/cfworker/`, saved like any other, so they hold on every device): the fill of the device copy (above) and TiddlyWiki's polling interval with its cost in worker requests — both read once, when a tab starts, so a change applies to tabs opened after it, as the tab says — and, under a warning, the advanced ones: the pause before a draft is written to the device (300 ms; lower is more writes, higher is more typing lost if the tab crashes), how many tiddlers the fill fetches at once (6; more is a faster fill with more requests in flight — on a private wiki they're worker requests either way, the same number), the pause after a save before the page is published (1 s; a burst of saves is published once), how often the worker is asked how backups go (60 minutes, with a list request; one R2 read each, and the alert when backups fail comes that much later), and how long the service worker waits for the network before answering with the page it kept (8 s; longer suits a slow connection, shorter a dead one; the page tells the service worker at each load, so that one applies at the next). The defaults fit the free plan and are what the tests run; an empty field is the default. The worker's own settings stay in the dashboard (2.5). Design 2.21.

**This device:** the plugin's *device* tab (Control Panel → Plugins → TiddlyWiki on Cloudflare) is about what this browser keeps of the wiki. *Measure* counts the tiddlers kept on this device of those the worker lists, with their size (the few the page itself carries — the site title, the default tiddlers, the settings — and any not loaded yet are counted apart); the changes and drafts waiting in the outbox; the files the service worker keeps, each with its size; then what the browser says — how much this site uses of what it allows (the browser's own count, more than the files' bytes) and whether it has promised to keep it. *Ask the browser to keep this site's data* asks for that promise: Firefox asks you; Chrome and Safari decide by their own rules — a site used often, installed or bookmarked — and answer at once (ask again later, or install the wiki as an app). Without it, a browser short of space may clear the site's storage, a change waiting in the outbox with it, which is why the cloud icon's dropdown says so while something waits, with a link to the tab; the page no longer asks at every load (in Firefox that was a prompt at every load). *Forget this device's copy* removes the device copy, the outbox and the service worker's files from this browser and reloads: the wiki comes back from the worker and the copy fills again, as on a new device; it's refused while a change or a draft waits, naming how many. Nothing in the tab asks the worker anything. Design 1.14, 2.22.

**Turning the browser modules off:** set `CONFLICT_GUARD` to `off`. The next page load rebuilds `baked.html` without them. Saves then go back to TiddlyWiki's default behaviour, without protection or request savings, and the page is no longer published.

---

## 4. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Every request answers 403 "didn't come through Cloudflare Access" | No Access application covers the hostname you're using (2.6): Access isn't set up yet, or it's set up on the custom domain only and you're on `workers.dev` or a preview URL | Set Access up as **Worker Access → All traffic**, or use the hostname it covers. For a local run without Access, set `ACCESS = off` (2.5); it only works for a local address. |
| The admin page says "There's no wiki yet" (404) | The bucket has no `index.html`, and the worker was deployed without the empty wiki (pasted into the dashboard alone, or `seed/` wasn't built) | Deploy with Wrangler or Workers Builds after `npm run build`, or upload `index.html` and `status` yourself (2.2). |
| Every request answers 500 naming `PUBLIC_WIKI_URL` | The variable isn't the public site's address (2.5) | Set it to `https://` + the bucket's custom domain (2.2), nothing after the hostname; or remove it, for a private wiki. |
| A Workers Builds run fails in the deploy step, before `Uploaded`, with `Received a malformed response from the API` or a `504 Gateway Timeout` on a `GET` | Cloudflare's API didn't answer one of Wrangler's reads of the worker (its secrets, its deployments) before the upload; the build itself passed ("Build command completed" is in the log) | Retry the build, or deploy from a machine: `npx wrangler deploy` in a clone (Node 22, 2.5). The site keeps serving the previous deployment meanwhile. If it keeps failing for an hour, report it to Cloudflare with the Ray ID from the log. |
| A private wiki's first load on a new device takes a while, with one worker request per tiddler | There's no public site to read from, so each tiddler comes from the worker, once per device (5) | Nothing: the device keeps a copy, and later loads fetch only what changed. |
| Alert "Edit conflict: … was changed in another tab or browser" | Another tab, device or script saved that tiddler after you started editing | Compare the tiddler with its `(conflict …)` copy, keep what you want and delete the copy. |
| Console shows "blocked by CORS policy" for the public site | The transform rule is missing or scoped wrong | Add or fix it (2.7). Until then, tiddlers simply load through the worker. |
| Offline, the page says it has no copy of the core file; or *Check the setup* (3) marks the files line ✗ | The CORS rule (2.7) doesn't cover `/_plugins/` (a rule set before that path was part of it) | Add the path to the rule's "When" (2.7), then open the admin wiki once online. Nothing but the check says so: the page's own request for a file works without the header. |
| The public site shows an old version | Browser TTL, or a failed purge | Check the cache rule's Browser TTL; look for `Cache purge failed` in the logs; purge manually. |
| Link previews or the tab show "My TiddlyWiki", or raw markup (yours or a plugin's) has no effect | The page hasn't been published since the change (design 1.9); for a plugin with JavaScript, the admin wiki hasn't been reloaded since installing it | Open or reload the admin wiki: it publishes once loaded. A notification says if it can't. |
| "GitHub backup: Backups to GitHub have been failing since …" alert | GitHub refuses the backups; the alert gives its answer | `Bad credentials` (`401`): the token has expired or was revoked. Make a new one (2.4) and put it in the `GITHUB_TOKEN` secret; the waiting backups then go through by themselves, and the alert goes. For other answers, the alert says what to check. |
| "Page not published: …" notification | The worker refused the page, or couldn't be reached | The message says why. It's tried again at the next save or load (a refused page once it changes); "index.html has changed" means reload the admin wiki. |
| "Page not published: The core file still switches the save template…" | A new TiddlyWiki version (a new `index.html`) writes the line the publisher takes out of the core file differently. | The site keeps working, built from `index.html` (heavier). Update the worker to a version that knows that TiddlyWiki, or go back to the previous `index.html`. |
| "Page not published: The page doesn't contain the TiddlyWeb plugin…" | TiddlyWeb was installed or updated from the wiki (the library, or a file dropped in), separately from `index.html`. It's then loaded as a file and left out of the page, and a page without it couldn't sync. TiddlyWeb is meant to match the core's version. | Delete it in the wiki and reload: the page still holds the one from `index.html`, and that load publishes. To move to a newer TiddlyWeb, upload an `index.html` of that TiddlyWiki version instead. |
| Console shows a failed `_plugins/tiddlywikicore.js` request | The core file is missing from R2 | Delete `_page/shell.html` and `baked.html` in R2 and open the admin wiki: it publishes both again. |
| The admin page downloads in full at every load | Neither `ETag` nor `Last-Modified` reaches the browser (look at the page's response headers), or "Disable cache" is ticked in DevTools | Without `Last-Modified`: check that the deployed worker is current (its pages carry it since `bakeVersion` 5). Cloudflare removing the `ETag` alone is expected (design 1.3). |
| The admin page reads a tiddler from the public site and then again from the worker | The public copy is out of date, often one cached before a worker that purges the admin page's copy (design 1.6) | Nothing breaks, only a request more. It clears up when that tiddler is saved, or when the cached copy expires (Edge TTL). To clear everything at once: Purge Cache → Custom Purge → Hostname `wiki.example.com`. |
| Tiddlers that existed before backups were set up have no commits | The backup covers saves made since; what came before needs a full backup | Control Panel → Saving → Cloudflare → *Back up everything to GitHub* (2.4). |
| The Cloudflare tab says the last full backup stopped without finishing | Its step's queue message was lost, or GitHub refused the token for hours (the alert says) | Fix what the alert says, if anything, and start it again: it skips what's already there. |
| No commits on GitHub | `GITHUB_REPO` or `GITHUB_TOKEN` not set (backups are then skipped without a log line), no queue consumer, or a GitHub token problem | Check 2.5 and 2.3, and look for `[Backup]` lines in the logs. Queued backups go through once fixed, if that's within the queue's retention (24 hours on the free plan). A direct backup logged as "could not be backed up" isn't retried. |
| The editor closes by itself after about a minute | The module isn't loaded (`CONFLICT_GUARD=off`, or an old tab) | Reload; check `$tw.syncadaptor.conflictGuardInstalled`. |
| Changes to `index.html` don't show | You haven't opened the admin wiki since uploading | Open the admin wiki once; it rebuilds `baked.html` and purges the public page. |
| A plugin is still inactive after the reload | You reloaded before the save finished, or the page build failed | Reload once the save has finished. A failed build is done again at the next page load; if the logs keep showing `Failed to rebake HTML`, the error after it says why. |
| The wiki doesn't start after installing a plugin | The plugin breaks at boot | Follow "If a plugin breaks the page" (3). |
| A tiddler that is in R2 doesn't show in the wiki | It's missing from the tiddler list: a save whose list update failed and was never retried (the tab was closed) | Delete `recipes/default/tiddlers.json` in R2: the worker rebuilds it from the stored tiddlers (design 1.2). A rebuild lists only tiddlers in the flat layout. |
| Console shows a failed `_plugins/…` request | The file is missing from R2 | Delete `baked.html` in R2 and open the admin wiki: the rebuild writes missing files. |

---

## 5. Known limits

- **Some titles can't be saved:** `.` and `..` (in a URL, the browser takes them for the folder or its parent, so they'd never reach the worker) and titles over 999 bytes (an R2 key holds 1,024). The admin wiki doesn't send them, which would fail and be retried forever: it keeps them in the tab and shows an alert asking to rename them.
- **A plugin that breaks at boot breaks both sites** until you remove it (3).
- **A damaged or missing list is rebuilt only while the admin wiki is open** (design 1.2): the worker's requests do the work, and public visitors don't use the worker. Until then the public site keeps what its cache holds; a visitor who gets the damaged list or the stand-in sees no tiddlers until it's done.
- **A rebuild step's CPU** stays around a normal save's, but a single stored tiddler with several megabytes in fields other than its text (rare: plugins keep their content in the text) is read in one step, and could take that step over the limit each time.
- **An installed plugin's raw markup reaches the page after a reload if the plugin has JavaScript** (design 1.9): TiddlyWiki only starts such a plugin then. And plugins with raw markup are in the page as well as in their file, so a big one makes the page bigger (the worker refuses a page over 2 MB).
- **Both sites depend on the core file on the public site,** as they already do on plugin files (a private wiki's, on the worker). If it can't be loaded, the wiki doesn't start (TiddlyWiki shows an alert).
- **Offline, the wiki is what this device has loaded** (3, "Opening the wiki offline"): the page, the core and plugin files, the last tiddler list and the tiddlers read on this device. A tiddler never opened here stays empty until the network is back; so does one changed elsewhere since. Clearing the site's data in the browser removes the copy.
- **A change made offline waits on the device it was made on,** and is sent from there (3, "Editing offline"): another device doesn't see it until that one is back online and open. Clearing the site's data in the browser discards what waits; so would the browser itself, if short of space and not having granted the site persistent storage (3, "Opening the wiki offline"): get back online before that.
- **A private wiki's first load on a device reads every tiddler from the worker,** one request each, then only what changed (the device keeps a copy): a thousand tiddlers is a thousand of the day's 100,000 requests, once per browser. There is no public cache to read from instead.
- **The page follows the admin wiki.** A change made elsewhere (a tiddler edited in R2) reaches the page at the next admin page load. Raw markup that depends on being logged in is rendered as the admin sees it.
- **Conflict copies are merged by hand.** That's by design: you get both versions and decide.
- **A short window at page load.** A tiddler that's part of `index.html` itself, edited before the first sync finishes, is saved without a version check.
- **Big imports take a while to back up.** GitHub allows about 500 commits an hour, so 1,000 tiddlers take a little over two hours. Nothing is lost while they wait.
- **Free-plan quotas** (October 2026, see 7): 100,000 worker requests a day; 10,000 queue operations a day, about 3 per backup or retry, so roughly 3,300 saves a day; 10 ms of CPU per request, with some flexibility for occasional overruns. Each save reads and rewrites the whole tiddler list, about 1 ms of CPU per 400–500 tiddlers, which is now the largest cost of a save. At several thousand tiddlers, saves could start hitting that limit. Saving a plugin also rebuilds the page, from the list the save has just written.
- **A tab closed right after a failed list update.** The worker stores a tiddler, then updates the tiddler list. If that update fails, the browser's retry completes it (design 1.4), but if the tab is closed first, the tiddler stays out of the list until the list is rebuilt (4).
- **The backup can't be checked out on Windows.** Its files are named after the titles (`tiddlers/$:/config/….json`), and Windows allows no `:` in a file name. Clone it on Linux, macOS or WSL to restore (2.4); on GitHub itself it reads fine.
- **A full backup takes as long as GitHub allows:** about 500 commits an hour, so a wiki of 1,000 tiddlers none of which were on GitHub takes a couple of hours, in steps of about 20 tiddlers; one already mirrored finishes in minutes, having only read. Its queue operations: 3 a step (design 1.7). Only one runs at a time; a second asked for meanwhile is refused.
- **Waiting backups cost queue operations.** If the GitHub token stays broken, every backup waiting is put back in the queue at the end of each pause (every 6 hours, once the pauses have grown): 1 queue operation for two pauses in three, 3 for the third, until it's fixed (the admin wiki shows an alert after an hour, design 1.7). A rate limit does the same while it lasts: a big import that GitHub slows down costs more than 3 operations a tiddler.

---

## 6. Development and tests

Requirements: Node.js 22 or newer (Wrangler 4 needs it) and a Chromium for the browser tests. (`npm run build` also makes `seed/empty.html`, the empty wiki the browser tests start from.)

```bash
npm install
npx playwright install chromium      # or: export CHROMIUM_PATH=/path/to/chrome
npm test                             # build (worker.js and seed/empty.html), run all sixteen suites
```

| Command | What it runs |
|---|---|
| `npm run build` | Writes `worker.js`, and `seed/empty.html`, an empty TiddlyWiki with the TiddlyWeb plugin, from the installed `tiddlywiki` package (kept when it's already of that version; `node tools/build-wiki.mjs --force` rebuilds it). |
| `npm run check:build` | Fails, writing nothing, if `worker.js` isn't what the sources build (run it before committing, so `worker.js` is never out of date). |
| `npm run lint` | ESLint, with its recommended rules only: a name that doesn't exist (a function moved without its import, say), an unused one, an import assigned to. CI runs it first. |
| `npm run test:fast` | The six suites that need no browser (a few minutes). |
| `npm run test:browser` | The ten suites that run a real TiddlyWiki in Chromium. |
| `npm run test:first` | A new wiki from an empty bucket, in Chromium (see below). |
| `npm run test:bake` | Page serving and rebuilding, the published page, the Access check, the public address, the first visit (see below). |
| `npm run test:integrity` | The tiddler list's integrity, the page after a failed build, draft-like titles and `.gitignore` (see below). |
| `npm run test:r2` | R2 calls per kind of request, against a budget (see below). |
| `npm run test:cpu` | CPU of the heaviest steps, a big plugin's save and backup, against a budget (see below). |
| `npm run test:backup` | Queue backup against an imitation of GitHub's Contents API (see below). |
| `npm run test:tabs` | Real TiddlyWiki in Chromium with several tabs (see below). |
| `npm run test:plugins` | Real plugins in Chromium, on the admin site and a stand-in for the public site (see below). |
| `npm run test:publish` | The page published from a real TiddlyWiki in Chromium (see below). |
| `npm run test:sync` | The full backup started from a real TiddlyWiki in Chromium, GitHub imitated (see below). |
| `npm run test:private` | A private wiki, no public site, in Chromium; then a public site added (see below). |
| `npm run test:offline` | Editing offline in Chromium, the network cut and restored (see below). |
| `npm run test:cold` | Opening the wiki with no network, in Chromium: the service worker (see below). |
| `npm run test:budget` | What reaches the worker per page load, counted behind a proxy, the service worker in place (see below). |
| `npm run test:setup` | The setup check, against the public stand-in with Cloudflare's headers, GitHub and Cloudflare's API imitated (see below). |

GitHub runs the same two groups, as two jobs side by side, for every pull request and every push to `main` (`.github/workflows/ci.yml`), after the lint and after checking that `worker.js` is what `src/` builds.

### 6.1 Repository layout

```
├── README.md                 this document
├── worker.js                 GENERATED: the file you deploy (npm run build)
├── seed/empty.html           GENERATED, not committed: an empty TiddlyWiki with TiddlyWeb, what a new wiki starts from (2.8), uploaded with the worker
├── tools/build-wiki.mjs      builds it from the tiddlywiki package (npm run build)
├── tools/restore.mjs         merges a clone of the backup into one file any TiddlyWiki imports (2.4)
├── docs/
│   ├── design.md             how the worker works, and why it's built this way
│   └── external-plugins.md   design notes for plugin files (design 1.8)
├── .github/workflows/ci.yml  runs the tests on GitHub for every pull request and push to main
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
│   └── browser/              the browser modules, embedded into worker.js by the build (3)
│       ├── lib.js            what they share: the sync adaptor, the public site's address, whether this is the admin site, titles in alerts (a TiddlyWiki library module)
│       ├── conflict-guard.js saves and deletes: the revision each is based on, conflicts, the flat layout
│       ├── list-sync.js      the tiddler list, loading (what's shown first, the device's copy, the fill), what isn't sent
│       ├── backup-alert.js   the alert while backups to GitHub keep failing (4.7)
│       ├── page-publisher.js the page published from the admin wiki (design 1.9)
│       ├── restore-import.js the backup's files dropped onto the wiki, imported with their tags (2.4)
│       ├── control-panel.js  the control panel's Cloudflare tab: the setup check (3), how backups go, the full backup (2.4)
│       ├── outbox.js         every change kept on the device until the worker has it: editing offline (3)
│       ├── cold-start.js     registers the service worker on the admin site (3)
│       ├── device.js         the plugin's device tab: what this browser keeps, measured, kept or forgotten (3, "This device")
│       ├── service-worker.js the service worker itself, served at /sw.js: the page, the core and plugin files, the status file and the last list kept for opening offline (3)
│       └── plugin-readme.txt, plugin-settings.txt, plugin-device.txt  the admin plugin's three tabs, wikitext (3, "The plugin and its settings", "This device")
│   └── app/                  the app's default icons (PNG), embedded by the build (3, "Installing the wiki as an app")
├── build.mjs                 inlines the modules into worker.js, in dependency order, with the browser modules embedded
├── eslint.config.js          the lint rules (npm run lint): names that don't exist, unused ones, an import assigned to
├── wrangler.toml             the worker's name, bindings and defaults: what Wrangler deploys, as it is; the settings are in the dashboard (2.5)
├── package.json              build, lint and test scripts
└── test/
    ├── first-visit.test.mjs  a new wiki from an empty bucket, in Chromium; the admin plugin's shadows (14 checks)
    ├── two-tabs.test.mjs     real TiddlyWiki in Chromium, several tabs, a restore (99 checks)
    ├── plugins.test.mjs      real plugins on the admin and public sites (66 checks)
    ├── page-publish.test.mjs the page published from a real TiddlyWiki (58 checks)
    ├── lazy-load.test.mjs    loading a big wiki on both sites: what's shown first, the device's copy, the fill; the fetch-ahead setting (32 checks)
    ├── backup-sync.test.mjs  the full backup from the admin wiki: the Cloudflare tab, the hint, the button, GitHub mirroring the wiki (12 checks)
    ├── private.test.mjs      a private wiki: everything from the worker, nothing purged, then a public site added (23 checks)
    ├── offline.test.mjs      editing offline: changes kept on the device, sent at the network's return or the next load; the draft pause setting (27 checks)
    ├── cold-start.test.mjs   opening the wiki with no network: the service worker, what it keeps and what it never keeps; the setup check from the tab; the network wait setting (33 checks)
    ├── budget.test.mjs       what reaches the worker per page load, behind a counting proxy, the service worker in place; the app's manifest as the browser fetches it (10 checks)
    ├── queue-backup.test.mjs queue backup against an imitation of GitHub, the full backup's steps (55 checks)
    ├── integrity.test.mjs    the tiddler list's integrity, a failed page build, draft-like titles, awkward titles, .gitignore, what a deploy uploads, the restore tool (88 checks)
    ├── r2-ops.test.mjs       R2 calls per kind of request, against a budget (35 checks)
    ├── setup-check.test.mjs  the setup check: each piece in place or missing, the lines naming the README sections (22 checks)
    ├── cpu.test.mjs          CPU of a big plugin's save and backup, against a budget (2 checks)
    ├── r2-counter.mjs        test-only wrapper that counts the worker's R2 calls
    ├── browser-harness.mjs   the browser suites' shared setup (worker, public site stand-in, Chromium, helpers)
    └── bake.test.mjs         page serving and rebuilding, tiddler and file reads, the published page, the Access check, the public address, the first visit, the app, the admin plugin (110 checks)
```

The worker is written as ES modules, each importing only from the ones below it: the entry point, the handlers, the page, the list, the layout, then the shared pieces (`src/worker/index.js` lists the order). The build inlines them into `worker.js` in that order, so one file is deployed, which you can paste into the dashboard, with every comment kept; it refuses two modules that import each other, an import of something not exported, and a name declared twice. The tests run the built `worker.js` in Miniflare, and import a module's functions directly where they test one (`test/cpu.test.mjs`, the checks in `test/bake.test.mjs`).

The browser modules live in their own files so they can be read and edited as normal JavaScript, one per concern, each a TiddlyWiki module, sharing a library (`$:/cfworker/lib.js`) for what the sync modules have in common. The build embeds each file of `src/browser/` in `worker.js` as a string, in place of a placeholder named after it (`"__LIST_SYNC_SOURCE__"` for `list-sync.js`) in `src/worker/build.js`'s table of them, and refuses a file without its placeholder, or the reverse. The strings are written as JSON, so a module can contain any character, backticks and `${` included.

---

### 6.2 The tests

The tests run the real worker in Cloudflare's local runtime (workerd, through Miniflare) with a local R2 bucket and queue. Outgoing calls to GitHub and Cloudflare's API are answered by imitations, so nothing touches your accounts. Every suite takes free local ports, so they can run at the same time. The ten browser suites share their setup, `test/browser-harness.mjs`: the worker, the stand-in for the public site, Chromium, and the helpers that wait for TiddlyWiki or record each tab's requests (marking the ones the browser answered from its cache, which never reached a server). (On a machine too busy to keep up, such as with the browser suites running alongside, the backup suite's "never overlapped" check can fail: Miniflare then starts a second batch before the first ends, which `max_concurrency = 1` prevents on Cloudflare. A browser suite can also time out waiting for TiddlyWiki there. Each passes run on its own.)

`test:bake` covers:
- Page serving: rebuild on an outdated bake or a new `index.html`, the `304` for an unchanged page (also with a weakened ETag, and by date alone, including two pages built within the same second), a byte order mark; CORS, a bad `PUT` path, and `/status`, kept by the browser for a week and no longer baked into the page; a tiddler read (its revision as ETag) and a file read (R2's), each answered `304` to a browser that has it (also with a weakened ETag, and to a `HEAD`), and sent when it has another version.
- The published page: the core file stored and each kind refused (also one sent for an older `index.html`, or without saying which) (also one still switching the save template, while the core plugin's escaped mentions of it are accepted), each kind of shell refused, a shell kept and the page built from it (the page and the answer carrying the stored shell's version), the same again, a shell from a page older than the one stored refused with the current version (also one built from a shell since replaced, or saying none), then kept once sent with it, plugin tags before the core (only in a shell: in a full `index.html` they stay in `<head>`, even with TiddlyWiki's marker in raw markup), a new `index.html` built from until a shell is published for it.
- `CONFLICT_GUARD = off`: the page built without the browser modules.
- Cloudflare Access: without `ACCESS = off`, every request (page, status, list, tiddler, save, delete, preflight) answers `403` and nothing is built or stored; the decision itself lets a request through that Access marked (`ctx.access`), refuses one without, and takes only `off` as the switch, and only for a local address: on a deployed hostname (`admin.example.com`, `workers.dev`) the switch changes nothing.
- `PUBLIC_WIKI_URL`: missing, a private wiki: the page is built and served with an empty public address, a plugin saved gets its file and the page loads it from this site at a root-relative URL, and nothing is purged though the purge settings are there; without `https://` or with a path, every request answers `500` naming it and nothing is built or stored; a trailing slash is fine; the check itself accepts none or a blank, and refuses the worker's own address.
- The first visit: an empty bucket with the empty wiki as the worker's asset gets `index.html` (the asset, byte for byte) and the public `status` file on the first page request, and the page; the next visit changes nothing; the asset isn't served at its own path; an `index.html` already there is used, not replaced, nor its `status`; one deleted by hand is put back and the page rebuilt from it; without the asset the page answers `404` saying what to upload.
- The app: the page linking the manifest with the site's cookies, a theme colour and the iOS icon; the manifest served as one, cached a day, complete (the wiki's title as the name, TiddlyWiki's own until set, start and scope at `/`, standalone, colours), with two PNG icons at 192 and 512 px inside it as data URLs, any purpose and maskable; the public site's copy written with the page, its icons at `/_app/` addresses, the default icons there; the wiki's title as the app's name and its short name when it's 12 characters or fewer; the owner's icon in the bucket replacing the default in the manifest and served at `/_app/icon-192.png`, the default served without one.

`test:integrity` covers:
- a save whose list update failed: its retry completes it, for a new and an existing tiddler, while real conflicts are still refused; a retry with other content refused, with the list brought up to the stored save (its fields included) and purged;
- a damaged or missing tiddler list: rebuilt from the stored tiddlers when it's served, saved to, deleted from or used for a page, with every field but the text, a save in TiddlyWeb's layout among them stored flat, leaving out the story list, drafts and objects not in the stored layout (an older layout, a URL-encoded key, no metadata), the damaged copy kept;
- a list too big for one request (400 tiddlers): `503` until it's complete (with `X-Tiddler-List` readable from another origin), the damaged list untouched meanwhile, two tabs driving it at once, a save and a delete in the middle retried successfully, a later damage or deletion starting over rather than resuming old progress, no progress left behind;
- a missing list: each rebuild with its own stand-in in R2, which isn't JSON;
- after a rebuild, the list purged from the public cache at once and again 5 seconds later;
- a save's purge sent only once the tiddler list is updated (its write held up through `test/r2-counter.mjs`);
- a title listed twice by hand, listed once after its next save;
- a list whose entries all have bag and recipe served byte for byte as stored, one without them given them;
- list writes landing out of order (one delayed through `test/r2-counter.mjs`): a delete after the title was created again keeps the new tiddler listed, a save landing between a delete's check and its removal (removed with it) isn't left listed, and an older save doesn't replace a newer entry;
- a page build that fails after a plugin save or delete (the page or the plugin file can't be written, through `test/r2-counter.mjs`): the change is still confirmed, the page is marked outdated, and the next page load builds it with the change (a load whose build fails too serves the last page built, not the bare `index.html`); a plugin file that can't be deleted (its plugin deleted, or saved as an ordinary tiddler): confirmed, and the page built without it; a page build and its outdated mark both failing after a plugin delete: the mark tried again a second later, and the next page load builds the page without the plugin; the mark failing again: the delete, or a plugin's save as an ordinary tiddler, answers `500` while the page still loads the plugin, and its retry builds the page without it and deletes the file;
- overlapping page builds: a save's build that read the shell before a new one was published (its page write delayed) doesn't put the old shell back;
- titles: a save whose title isn't text, or isn't the one in its URL, or is too long for an R2 key, is refused (`400`; the longest that fits is stored and deleted, and one too long is "deleted" with a `204`), a path that isn't valid percent-encoding refused (`400`) by reads, saves and deletes, and such tiddlers stored by hand are listed under their key instead of stopping the rebuild or being listed under the wrong title; awkward titles (a comma, `%`, `#`, `&`, `+`, accents, emoji, spaces, quotes, slashes, a backslash) going through create, read, `If-Match` with the ETag they got, `412`, the list, the purge URL and delete;
- the restore tool (`tools/restore.mjs`): a backup clone collected with its subdirectories and sorted, tags as TiddlyWiki writes them, the old revision, bag and recipe left out, a custom field called `fields` flat again, what isn't a tiddler left out and said, run as a command on a clone and on one file;
- a field called `fields` stored nested, as TiddlyWeb's layout has it; a value that's an object refused (`400`), and a tag that isn't text (in either layout), while one already listed doesn't stop the page from being built; a body sent as the flat layout with a field after the text (listed), and with a text that isn't text or garbage after it (refused); custom fields named like built-in properties (`constructor`) kept, and a `text` among the custom fields doesn't move the text;
- a save of a tiddler whose text never loaded (`_is_skinny`), in both layouts, keeping the stored text without storing the mark, and one the worker doesn't have stored without text;
- tiddlers titled `Draft of '…'` saved and deleted like any other, while real drafts still aren't stored; titles starting like `$:/StoryList` (`$:/StoryList/2`) stored, `$:/StoryList` itself not;
- `wrangler.toml` part of the repository with no secret in it and every binding the worker needs, deployable without an edit (the settings kept in the dashboard, the admin site on `workers.dev`, no value to fill in), `.gitignore` covering Wrangler's local files (`.dev.vars`, `.wrangler/`).

`test:r2` runs the worker unchanged behind `test/r2-counter.mjs`, which counts every R2 call it makes, including work left running after the answer (and can make chosen calls fail, which `test:integrity` and `test:backup` use, and tells which queue run made each, counts queue operations and can make the queue refuse messages, for `test:backup`). Each kind of request has a budget, and a change that makes more calls fails. It also checks that a save reads the stored tiddler and the list at the same time. These are the counts now:

| Request | R2 calls |
|---|---|
| First visit of a new wiki (once) | 16: the page request's two reads, the engine and the status file written, the engine looked up again, then the page build with the missing list made from the stored tiddlers (none) |
| Admin page load, page up to date | 2: read `baked.html`, check `index.html` |
| Admin page load, the browser has the page (`304`) | 2: check `baked.html` (its body isn't read), check `index.html` |
| Tiddler list, first fetch or unchanged (`304`) | 1 |
| Tiddler list asking how backups go (page load, then hourly) | 2, at the same time: the list and `_backup/status.json` |
| Tiddler read from the worker (a public copy that's stale or missing, or the conflict guard), first or unchanged (`304`) | 1 |
| The setup check (`GET /setup/check`) | 1: `baked.html` looked up, its ETag against the public site's `/` (the rest is requests to the public site, GitHub and Cloudflare, bodies unread) |
| Update the engine (`POST /engine/update`) | 2: the engine's head read for its version, the shipped empty wiki written over it (the page build follows at the next load) |
| Start a full backup (`POST /backup/sync`) | 3: the backup status, the tiddler list, the status written; then, in the queue, a step is 1 listing, 2 reads per tiddler, the status read and written |
| Save a new tiddler, or an update | 4: look it up and read the list (both at once), write the tiddler, write the list |
| Save refused (`412`) | 2: look it up and read the list, both at once (the stored tiddler itself is read only if it's the same size as the save, to recognise a save sent again) |
| Save sent again, already stored | 5: look it up, read it to compare, read and write the list, and look for a plugin file the first attempt may have left behind (design 1.8) |
| Delete | 4: read the list, look it up, delete it, write the list |
| Save a plugin | 12: the save's 4, and the page build: look up `index.html` and the stored core file and read the published shell (all at once), check and write the plugin file, read the stored plugin, check and write `baked.html`. The page build reuses the list the save wrote, and checks every other plugin's file too (one `HEAD` each). Before the first publish, with no shell, it reads `index.html` as well: 13. |
| Delete a plugin | 10: the delete's 4, the page build's 5 without that plugin's file, then the file deleted (11 before the first publish) |

Backups don't appear here: with the queue bound, as deployed, they run later in the queue consumer.

`test:cpu` loads the built worker's own functions in Node, which runs the same V8 as Workers, and measures the CPU of the two heaviest steps for a 4.8 MB plugin. Each budget is relative to `JSON.parse` of the same bytes on that machine (what the worker avoids), so it holds on a faster or slower one:
- reading a save in the flat layout: at most 0.25× (it parses only the fields before the text; about 0.12×);
- its backup from its R2 copy: at most 2.5× (the git hash and base64 worked out on bytes; about 1×, where encoding it through strings took about 4–6×).

Reading the save in full, or building the backup's request through strings, fails its budget.

`test:backup` covers:
- a 150-tiddler import (one commit each, never two at once, byte-identical content);
- quick successive edits;
- a rate limit and an outage;
- a version delivered late;
- delete then recreate;
- a 200 KB tiddler;
- messages kept under 64 KB as sent: a 70 KB Latin-1 text, a 40 KB one that takes two bytes a character, and a big one with a title too long for an R2 key, wait in R2; a 60 KB Latin-1 one fits in the message;
- saves in the flat layout, small and large;
- a tiddler over 1 MB saved twice, with a later backup behind it;
- three big versions waiting in one batch: one per run, all committed exactly;
- non-ASCII text;
- a title with quotes and a backslash, in its commit message; one with a comma, `%`, `#`, `?` and `+` under its own name;
- a duplicate delivery;
- a rate limit pausing every backup: 40 saves during 6 seconds of it make 3 GitHub calls, then all go through;
- the full backup: 63 tiddlers stored before backups existed (one with a slash, a 600 KB one, one GitHub refuses), one GitHub already had the same, one it had older, two files on GitHub of titles not in the wiki; started with `POST /backup/sync` (202 with its status, 409 while it runs, the progress in the tiddler list's answer), it finishes with every tiddler on GitHub byte for byte, the same one not committed again, the older one updated once, a tiddler saved meanwhile committed once, the two files removed, the refused one reported, in steps each within a run's budget of GitHub calls; a second run commits nothing; one without progress for hours counts as lost and a new one starts; without GitHub or without the queue, 400 naming what's missing;
- a file GitHub keeps refusing: the backups after it go through, it keeps being retried, and goes through once accepted;
- one file answered `404` (like a repository out of reach) doesn't pause the others, and is reported;
- a version GitHub refuses for good (a secret in its text): that tiddler's next version goes through, the refused one is then dropped, and so is one whose tiddler was deleted, with the alert cleared;
- a token GitHub refuses (`401`), and one that can't write (`403` on every write): every backup pauses, the waits mostly through the queue's own retry (never past a message's third delivery), so 20 of them waiting make 3 GitHub calls in 6 seconds (10 with a `403`: 12 in 5), and the pause ends once they go through;
- what the admin wiki is told: a refused file (with GitHub's answer), every backup failing with a token GitHub refuses (how many, the oldest, since when; only to a request that asks), cleared once they go through; a rate limit not reported; a direct backup that fails for good recorded, and reported only after `BACKUP_ALERT_MINUTES`; an R2 error while recording that doesn't make a backup that went through count as failed;
- GitHub's copy not decoded (only its `sha` used), and a late version whose "newer version restored" step fails, put back by the retry, without committing the late version again when a newer one was committed meanwhile;
- a big version's R2 copy that can't be removed after its commit: the backup still counts as done;
- a message the queue refuses (its daily operations used up, say): the save backed up directly instead, small or big, the big one's R2 copy removed;
- the fallback without a queue.

`test:first` starts from an empty bucket, with `seed/empty.html` uploaded with the worker, and covers:
- the first admin page load, which puts the engine and the status file in the bucket and boots a logged-in, writable wiki with the browser modules (the library and the six startup modules, loaded in order, each part of the sync in place) and nothing to load, and publishes the core file and the page for the public site;
- a tiddler saved from it, stored and listed;
- the public site (the stand-in) serving the page to a visitor who sees the tiddler, read-only, without ever using the worker.

`test:tabs` covers:
- **Conflicts:** an editor open while another tab saves, a stale tab, a new title created in two tabs, a stale delete, identical edits (also of a tiddler created in the tab), a save stored though its answer was lost and edited again before it's tried again (no conflict copy), rename, a rename or a delete from an editor opened before another tab's save (refused, that version kept, also when fetching it after the refusal fails once), simultaneous saves, conflict copies of a JavaScript module, a plugin and a raw markup tiddler with the older `$:/core/wiki/rawmarkup` tag that don't run (no file, no script tag; a fresh load runs only the version kept), with an alert saying so and how to use that version (also when the original was deleted elsewhere).
- **Baking:** startup tiddlers with their custom fields.
- **Public cache:** exact purge URLs (the tiddler list's as TiddlyWiki itself requests it, so a TiddlyWiki that changes it fails the test; also the admin page's copy, purged with its `Origin` header, on a save and a delete) and the `304`.
- **Request savings:** `/status` asked from the worker once by the first page load in a browser, then answered from the browser's cache: a 2-request page load (TiddlyWiki still knows it's logged in), the tiddlers taken from the device, a reload that downloads none of the page (`304`), also through a stand-in for Cloudflare that removes the page's ETag (the browser asks by date), the stale-public-copy fallback to the worker, a missing CORS header, the hidden-tab pause.
- **A damaged tiddler list** rebuilt over several requests while a tab is open: the tab keeps its tiddlers and shows no error; a save answered "rebuilding" is sent again quietly, and any other `503` is reported as before.
- **A tiddler changed before its text loaded** (its text held back): the stored text kept with the change, and the tab then loads it.
- **Failing backups:** a page load asks how backups go with its first tiddler list request, shows an alert (since when, how many, the oldest, GitHub's answer, what to do), asks at each request while it shows, removes it once backups get through, then asks no more than hourly.
- **Leaving with an editor open:** the browser asks before closing a tab whose editor holds changes, not one left unchanged; the half-typed draft is back in the next tab, from the device.
- **What's sent is what's stored:** a tiddler with an empty `draft.of` field (a draft, for TiddlyWiki) isn't sent and stays in the tab after a poll; a second story river's `$:/StoryList/2` is stored; tiddlers titled `.` or `..` aren't sent, and the tab asks to rename them.
- **Titles at the edges:** alert links that work for a title ending in `]` or holding `]]` and `|`; a conflict copy of a tiddler whose title is near the length limit, saved under a shortened name.
- **A public site that doesn't answer:** the text comes from the worker after 5 seconds, instead of loading waiting for good.
- **Restoring from the backup:** TiddlyWiki's own deserializer drops a stored tiddler's tags; dropped onto the admin wiki (TiddlyWiki's file-import path, where the restore-import module runs), a backup file comes through with its tags as text, without the old revision, bag and recipe, also a file of several (a nested custom field called `fields` flat again), while a plain JSON export and an HTML wiki file are read as TiddlyWiki reads them; imported, the tiddler is created again on the server with every field the same but the revision, and no conflict.

`test:plugins` uses the markdown and KaTeX plugins shipped with TiddlyWiki and covers:
- **Install** through the import messages a drop sends: the flat save, the stored tiddler, the file (byte for byte the template format), the script tag, no purge of plugin files.
- **After the reload:** the plugin works, no reload loop, plugin code never comes through the worker, at most two worker requests per page load, the browser cache on the next load.
- **The public site:** the plugin works, with no worker request.
- **Update, disable and re-enable, a theme, the sync settings, a standalone module, delete,** and a plugin turned back into an ordinary tiddler.
- **Edge cases:** a body containing `,"text":` in a field and in the text, a tiddler without text, a field called `fields` (stored nested, and read back after a reload, on an ordinary tiddler and on a startup tiddler and a module loaded at boot), "flat" bodies that aren't and a save in TiddlyWeb's layout (both stored flat), a title with spaces, `#` and non-ASCII, a stored plugin whose file is missing, overlapping page builds, a tiddler list replaced by hand, and the recovery steps.
- **A public tab while the tiddler list is missing or damaged:** it keeps its tiddlers and doesn't crash, asks again at a URL no cache holds, and catches up by itself once the worker has rebuilt the list; after a damaged list, its next sync bypasses caches too, and a damaged copy its browser kept is passed over quietly; it never asks how backups go (only the admin site does).

`test:publish` starts from the full test wiki as `index.html` and covers:
- **The first admin load** publishing the core file (TiddlyWiki's, without the snapshot setting, which the worker checks) and the shell (TiddlyWiki's external-core page, a fraction of the size), `index.html` untouched; the next load getting the light page with the core from the public site, at 2 worker requests, publishing nothing.
- **A plugin that came with `index.html`, updated from the wiki,** saved like an installed one (no conflict copy, still on both sites), and a conflict for a second tab updating it from the page's version too; deleting that update removing the plugin, as in a single-file wiki, and deleting the published shell and the page in R2 bringing back `index.html`'s version.
- **A plugin installed from the wiki** staying a file, loaded before the core.
- **One with raw markup** also written into the page with its markup, published once when it's installed, updated or deleted (one with JavaScript at the next load, then running its markup first), nothing published at a reload.
- **What another tab deleted** (a raw markup tiddler, a plugin) not published again by a tab that still has it, a plugin deleted here and installed again elsewhere taken for an installed one, and a deleted tiddler left in the page by a failed publish taken out at the next admin load.
- **The title and raw markup** published once per burst, each where TiddlyWiki puts it, the Open Graph tags with your title, the copies in the page with the worker's revisions.
- **The public site** running from the page, splash screen removed once started, and still read-only and publishing nothing when visited over `http` while its address says `https`.
- **Nothing published** for a save that doesn't change the page (not even a list request) or typing in a draft.
- **Another tab** not publishing at load or for changes it receives, a tab publishing after another including that one's change, a page that reaches the worker after another tab's though rendered before that tab's change (held back) refused and sent again with the change, and a change another tab published, undone in this one, published by it.
- **An edit made in R2** published at the next admin load once its slow-loading text has arrived.
- **A failed publish** reported and retried (and one the worker kept, its answer lost, then undone: published), a refused one sent again only once the page changes, a refused core file not sent again at the next changes, the core file sent once, not at every load, while the worker keeps refusing the page, and an error while rendering the page too, without stopping later publishes.
- **A new `index.html`** used at once, then published for (the core file not sent again).
- **Safe mode** neither publishing nor syncing.

`test:lazy` stores 120 tiddlers (two of them with a comma, `%`, `#`, `?`, `+`, a slash, quotes, accents and an emoji in the title) and covers, on the admin site and on the public site:
- **What's shown first:** a tiddler opened directly is the first one fetched, before the background fill.
- **The fill:** everything loads from the public site, several requests at a time, nothing through the worker; a hidden tab loads what it shows and fills once shown (leaving out a tiddler deleted meanwhile, without an error), and one hidden in the middle of the fill stops fetching until shown; a save while the fill runs publishes the page without waiting for it.
- **The device's copy:** a refresh fetches no tiddler (the worker serves the page and the list only) and stores them in a few load steps rather than one by one; after a change elsewhere, that tiddler only; one saved in the tab isn't fetched; one deleted elsewhere, or in the tab, is gone from the tab and the device; without IndexedDB, loads go over the network each time.
- **The fill turned off** (`$:/config/cfworker/LoadAll`, built into the page): only the tiddler shown is fetched, the others stay skinny, another loads the moment it's needed, a loaded tiddler changed elsewhere is still reloaded, a skinny tiddler changed before its text loaded keeps its text and gets it; with TiddlyWiki's own lazy loading off, the fill runs whatever the setting.
- **A stale copy from a cache** refused and fetched again past the cache, on both sites, without the worker.

`test:private` runs the worker with no public address at all (the stand-in for the public site runs, to show nothing reaches it), from an empty bucket, and covers: the first visit (the engine and the status file stored, the page built with no public address, the tab logged in and writable, the core file and the page published by itself with the core at a root-relative URL); a save stored and listed; a reload getting the light page with the core file from the worker, then the next one asking the worker for the page and the list only (the core from the browser's cache, the tiddlers from the device copy); a plugin installed, its file loaded from the worker at a root-relative URL and run, from the browser's cache at the next reload; the Cloudflare tab, saying backups aren't set up; every request of the tab gone to the worker and none anywhere else, and no purge sent though `CF_ZONE_ID` and `CF_API_TOKEN` are set; a second browser reading the tiddlers from the worker, and a tiddler saved afterwards at its next poll; then `PUBLIC_WIKI_URL` set on the running worker, as in the dashboard: the next load rebuilt with the public address and every tiddler still there, the page published again with the core from the public site, the page loading its core and plugin files from there, a new browser reading the tiddlers from the public site and not the worker, and a save purging it.

`test:offline` runs a private wiki in Chromium with the network cut and restored (Playwright's offline mode), and covers: nothing waiting online (nothing in the dropdown, an empty outbox on the device); offline, a new tiddler, a change and a delete retried by TiddlyWiki with no alert shown (TiddlyWiki's network alert would be back at every retry), the cloud icon's dropdown saying 3 changes are waiting since when, kept on this device, offline, and each change on the device the moment it's made with the revision it's based on; the network back, with TiddlyWiki's retry set 20 s away: the three reach the worker within a second (the online event), the dropdown's item and the outbox cleared; offline again, still no alert; a change made offline, the tab reloaded once the network is back: it comes back from the device and is sent with the revision it was made from (`If-Match`; `If-None-Match: *` for a new tiddler), stored and listed, nothing waiting after; the tab closed while offline, a new tab sending what it had kept; a delete made offline, then a reload: deleted on the worker with its revision checked, gone from the wiki, not brought back by the list; a tiddler another browser changed while this one was offline: a conflict copy and an alert at the network's return, the other version kept, nothing waiting; a draft open while offline, kept on the device without counting as a change, back with its text after a reload, never sent to the worker, and gone from the device when cancelled; two tabs in one browser, a change made offline in one and the other reloaded: stored once, no copy, nothing waiting in either; a save the worker refuses (`500`): the dropdown saying 1 change waiting, sending (still online), TiddlyWiki's own error alert rather than the network one, kept on the device, and through once the worker takes it; a tab opened while another tab is typing a draft not adopting it (the draft stays with its tab, and on the device), and getting it back once that tab is gone; a change an open tab is still trying to send not sent by a tab opened meanwhile, and sent by the first once the worker takes it.

`test:cold` runs a private wiki in Chromium with R2 on disk, and takes "no network" as the worker and the public stand-in taken down (the browser's offline mode doesn't cut a service worker's own requests) and the browser offline, then brought back. (The other browser suites block the service worker, so what they watch at the page — requests, headers, `304`s — stays what reaches the worker.) It covers: the first visit registering the service worker, in control from the next load at a versioned address, the cache then holding the page, the core file, the status file and the tiddler list; the Cloudflare tab's "Check the setup" button listing the pieces, this browser's service worker and its copy of the core file among them; with no network, the wiki opening from the service worker, those from the cache, the tiddler from the device copy, logged in and writable; a change made then waiting in the outbox and reaching the worker at the network's return; a tiddler never loaded on this device, opened offline, still empty, the wiki saying it's offline, no alert, nothing broken; another device after its first visit alone, no reload, the cache holding the page, the core file, the status file and the tiddler list, and the wiki opening with no network, the tiddlers from its device copy; online, an answer without the worker's mark (the worker refusing without Access) shown as it is through the service worker and not cached, the wiki still opening offline from the page kept before; a plugin installed, run at the next load with its file in the cache, run offline from it; the core file gone from the cache, back at the next load online (a reload, whose request for the file the worker answers `304`); no network and no copy of the core file on the device (the browser's own copy gone too), the page saying so in a line, not the browser's "Cannot load" alert, the wiki back once online; a public wiki, the admin page loading its core and plugin files from the public site and opening offline with them from the cache, the plugin running, the files kept as real answers asked for with CORS and never opaque; the setup check there saying the public site answers with the page and the CORS rule covers the reads and the files, and, the header off, its files line failing naming `/_plugins/`; without the public site's CORS header, a new plugin file loading and running online as a plain script and not kept, then kept as a real answer once the header is there; the browser asked to keep the site's storage, the status saying its answer; the plugin deleted, its file leaving the cache at the next load; the public site registering nothing.

`test:budget` puts a counting proxy in front of the worker and opens the admin wiki in Chromium with the service worker allowed, so that what's counted is what reaches the worker — including requests the browser makes on its own, which no page sees (the check of the service worker's script, the favicon, the app's manifest). It covers: the first visit (the page, the status file, the list, the script once, the page (`304`) and the list once more for the service worker's own copy, the core file and the page published, the browser's favicon and manifest requests, nothing else); the browser's fetch of the app's manifest, driven through the DevTools protocol as an install does it, reaching the worker with the site's cookies and reading clean, and the browser finding the wiki installable (its one objection being the test browser's incognito mode); the first reload (the light page, the core file once, the list; nothing for the script or the favicon); past the browser's first minute, every reload reaching the worker exactly twice, the page and the list, both `304`, the script never asked for again; a tab in the background asking nothing, and catching up with one list request once shown.

`test:setup` runs the worker behind the public stand-in, which sends Cloudflare's headers (`ETag`, `CF-Cache-Status`) and serves `/` as `baked.html` like the rewrite rule, with GitHub and Cloudflare's API imitated and the worker's own requests recorded; no browser. It covers: everything in place, every line fine, the public site asked for the page, the list, the core file and the status file with the admin site as `Origin`, GitHub asked for the repository and its branch with the token, Cloudflare asked to purge the status file's cached copy; the rewrite rule missing (the public site's `/` isn't the page), named with 2.7, the other lines fine; the CORS header missing under `/_plugins/` only, the files line failing naming that path, the reads line passing; missing on both paths, both failing; no cache rule (`DYNAMIC`), reported with what was found, not a failure; cached, said so; the public site not answering, its line naming 2.2 and the rule lines left unchecked; GitHub refusing the token (401), not finding the repository (404), the branch missing, each named with 2.4; Cloudflare refusing the purge, named with the token's section; backups not set up, named with 2.4, and no purge token an optional piece; the queue not bound, named with 2.3; a private wiki, the public site's lines saying there's nothing to check. `test:r2` counts its one R2 call; `test:bake` lists its route among those refused without Access; `test:cold` clicks the button in the Cloudflare tab, on a private wiki and a public one, and reads the lines, this browser's service worker and its copy of the core file among them, and the files line failing with the public site's CORS header off.

`test:sync` runs the worker with its queue and an imitation of GitHub, and covers: the Cloudflare tab under the control panel's Saving tab (backups on, no full backup yet, the button); the hint when backups are on and none has ever run, which stays closed in that browser once closed; the button starting a full backup, the tab following it (running, then the last full backup with its counts), 12 tiddlers stored before backups existed on GitHub byte for byte and a file of a title not in the wiki removed; a second run committing nothing; a save after that committed by its own message; no tab on the public site; a worker without backups: the tab says so, no button, no hint.

To run the browser tests against your own wiki file, download `index.html` from the bucket and run `WIKI_HTML=/path/to/index.html npm run test:tabs` (or `test:plugins`).

---

## 7. Reference

Limits and behaviours this design relies on (checked October 2026):

- **Workers:** [platform limits](https://developers.cloudflare.com/workers/platform/limits/) (requests per day, CPU and its flexibility for occasional overruns, subrequests); [how the cache works with Workers](https://developers.cloudflare.com/workers/reference/how-the-cache-works/) (worker-generated responses aren't cached).
- **Cloudflare Access on Workers:** [`ctx.access`, and why a worker with static assets never gets it](https://developers.cloudflare.com/workers/configuration/cloudflare-access/); [additional modules](https://developers.cloudflare.com/workers/wrangler/configuration/#bundling) (`rules`, how the empty wiki travels with the worker).
- **R2:** [Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), including conditional `put` with `onlyIf`.
- **Queues:** [limits](https://developers.cloudflare.com/queues/platform/limits/) (128 KB messages, 24-hour retention on free, 100 retries, delays up to 24 hours) and [pricing](https://developers.cloudflare.com/queues/platform/pricing/) (10,000 operations a day on free).
- **Cache:** [cache rule settings](https://developers.cloudflare.com/cache/how-to/cache-rules/settings/) and [their order](https://developers.cloudflare.com/cache/how-to/cache-rules/order/) (the last matching rule wins); [purge methods and rate limits](https://developers.cloudflare.com/cache/how-to/purge-cache/); [single-file purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/); [browser cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/) (4-hour default); [ETag headers](https://developers.cloudflare.com/cache/reference/etag-headers/) and [Replace insecure JavaScript libraries](https://developers.cloudflare.com/waf/tools/replace-insecure-js-libraries/) (removes the ETag of HTML, on by default on Free); [single-file purge with an `Origin` header](https://community.cloudflare.com/t/why-after-purge-cache-the-data-keep-old-when-with-origin/553911) (the header is part of the cache key).
- **GitHub:** [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), including the secondary limits of 80 content-creating requests a minute and 500 an hour.
- **TiddlyWiki:** the TiddlyWeb adaptor (`$:/plugins/tiddlywiki/tiddlyweb/tiddlywebadaptor.js`), the syncer (`$:/core/modules/syncer.js`), plugin handling (`$:/core/modules/startup/plugins.js`) and the boot sequence (`boot/boot.js`).
