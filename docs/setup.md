# 2. Setting up

*Chapter 2 of the [manual](../README.md#the-manual). Each step names what the next ones need.*

About ten minutes, in this order.

## 2.1 Before you start

**A private wiki, or a public one.** A private wiki skips the public site: in [2.2](#22-the-bucket-and-the-public-site) only the bucket, no custom domain; no zone rules ([2.7](#27-the-zones-rules-public-site-only)); in [2.5](#25-the-worker) no `PUBLIC_WIKI_URL`, `CF_ZONE_ID` or `CF_API_TOKEN`. About five minutes. The steps marked *(public site only)* don't apply. Its first load on a new device reads every tiddler from the worker ([limits 5](limits.md)); after that, only what changed. To make it public later, do those steps then, in the order of [operating 3.22](operating.md#322-making-a-private-wiki-public): nothing moves, but everything written so far becomes public with the domain, so a public wiki can't hold private tiddlers: delete them first, or move them to a second wiki that stays private ([2.9](#29-a-second-wiki)).

**By hand, from a fork.** Fork this repository on GitHub: Cloudflare deploys the worker from the fork's `main` branch with Workers Builds ([2.5](#25-the-worker)), and from then on every push to it deploys. Nothing in the fork is edited, so an update is GitHub's *Sync fork* ([operating 3.1](operating.md#31-updating-your-copy)). Then do [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit) in order; the names below apply throughout. *Check the setup* ([2.8](#28-the-first-visit)) then shows every line fine from the second load (the first leaves the core file's copy for the service worker to take).

The names, and where each goes. With the defaults, nothing in the repository needs editing: the worker is deployed as it is, and your settings are entered in the dashboard ([2.5](#25-the-worker)).

| Name | Default or example | Where it goes |
|---|---|---|
| the public site *(public site only)* | `wiki.example.com`, yours | the bucket's custom domain ([2.2](#22-the-bucket-and-the-public-site)), the setting `PUBLIC_WIKI_URL` ([2.5](#25-the-worker)) and the zone rules ([2.7](#27-the-zones-rules-public-site-only)) |
| the admin site | `wiki-admin.<your subdomain>.workers.dev` | the worker's own address, behind Access ([2.6](#26-cloudflare-access)), allowed by the CORS rule ([2.7](#27-the-zones-rules-public-site-only)); a custom domain instead, if you like ([2.5](#25-the-worker)) |
| the bucket | `wiki` | [2.2](#22-the-bucket-and-the-public-site); `wrangler.toml` if you name it otherwise |
| the queue | `wiki-backup` | [2.3](#23-the-backup-queue); `wrangler.toml` if you name it otherwise |
| the worker | `wiki-admin` | the name you give it in [2.5](#25-the-worker); `wrangler.toml` if you name it otherwise |

`wrangler.toml` holds the bindings and the defaults above; its comments say what each is for. No secret goes in it, ever: the two secrets are entered in [2.5](#25-the-worker), with the settings.

## 2.2 The bucket and the public site

1. In the Cloudflare dashboard, under **R2**, create the bucket (`wiki`). Nothing to upload: the worker fills it on the first visit ([2.8](#28-the-first-visit)). For a private wiki, that's all: leave public access off, and **Public Development URL (`r2.dev`)** disabled.
2. *(public site only)* In the bucket's settings, turn on public access. Everything in the bucket is public through the domain from the moment it's connected, every tiddler, the tiddler list and the page, and for a wiki that was private, everything written so far ([operating 3.22](operating.md#322-making-a-private-wiki-public)). That's intended: nothing private belongs in a public wiki's bucket (secrets live in the worker's settings). Then:
   - **Custom Domains:** connect `wiki.example.com`.
   - **Public Development URL (`r2.dev`):** keep it disabled. It's a second public address that skips the zone's cache and rules.
   - **CORS Policy:** leave it empty. A transform rule handles CORS instead ([2.7](#27-the-zones-rules-public-site-only)).

   Wait for the domain before going on. Custom Domains shows it *Initializing*, then *Active*, within a few minutes (refresh the page to see it change; if it stays, *Retry connection* in the domain's menu). Then open `https://wiki.example.com/status` in a browser: a page from R2 means the domain answers (a 404, *Object not found*, while the bucket is empty; the status file's JSON after the first visit), while a connection error or an error page from Cloudflare means not yet. Set `PUBLIC_WIKI_URL` ([2.5](#25-the-worker)) only then: set while the domain doesn't answer, the admin wiki can't publish its page, and says so until the site does; *Check the setup* run meanwhile says the site answered 530, Cloudflare's edge with no bucket behind the host yet, and to check again in a few minutes ([operating 3.15](operating.md#315-checking-the-setup)). The domain goes on the bucket the worker is bound to, the one `wrangler.toml` names (`wiki`, unless you changed `bucket_name`): on another bucket, the site answers but serves nothing of the wiki, and the check says so.

## 2.3 The backup queue

Under **Storage & Databases → Queues**, create the queue (`wiki-backup`). That's all: the deploy ([2.5](#25-the-worker)) binds the worker to it as its producer and consumer, with the settings in `wrangler.toml` (batches of 10, 5 seconds, one at a time, 3 retries). Don't lower the retries: the worker counts on them for its waits ([design 1.7](design.md#17-github-backup)).

Create the queue before the worker's first deploy ([2.5](#25-the-worker)): Wrangler refuses to deploy while a queue named in `wrangler.toml` doesn't exist. A worker without the queue binding (pasted into the dashboard without it, [2.5](#25-the-worker)) runs the same backup directly after each save, with a couple of quick retries but no long-term waiting.

## 2.4 The backup repository (optional)

- **A repository of its own** for the backup, one per wiki. **Private, for a private wiki:** a public repository publishes every save, with its history, for anyone to read, and *Check the setup* says so ([operating 3.15](operating.md#315-checking-the-setup)); for a public wiki, as you like. Files go in `tiddlers/`. Never use the repository the worker is deployed from: its token would let anyone who got it change the worker's code.
- **A fine-grained personal access token** limited to that repository, with *Contents: read and write*. [This link](https://github.com/settings/personal-access-tokens/new?name=wiki+backup&description=One+commit+per+save+into+the+backup+repository+%28tiddlywiki-cloudflare%2C+setup+2.4%29&expires_in=366&contents=write) opens GitHub's form with the name, the permission and the longest expiry the form allows (a year) filled in; what's left is *Repository access → Only select repositories* → the backup repository, then *Generate token*. You'll store it as the `GITHUB_TOKEN` secret ([2.5](#25-the-worker)). When it expires, the admin wiki shows the backup alert (`Bad credentials`): make a new one the same way and replace the secret.

Without a repository and a token, the worker skips backups: the wiki then has no history, since the bucket keeps the current version of each tiddler alone, and a deletion or an overwrite is final.

**A wiki that already has content** when backups are set up — an imported wiki, say — has nothing on GitHub until a **full backup** runs: the admin wiki reminds you once, and the button is in the Control Panel → Saving → **Cloudflare** tab, *Back up everything to GitHub*. For a big wiki, more than about 1,500 tiddlers, that's the cheaper order anyway: import first, then set the repository and the token ([2.8](#28-the-first-visit)).

It makes GitHub mirror the wiki: every stored tiddler GitHub doesn't have, or has differently, is committed, and files of tiddlers no longer in the wiki are removed; run again, it changes nothing.

It runs in the backup queue, without the tab, at GitHub's pace (about 500 commits an hour), and the tab shows its progress (as of its last minute's refresh, or *Refresh*). Run it once after setting backups up, after a restore (below), after putting a tiddler in the bucket by hand, or in any doubt.

**Restoring from the backup:** the backup is the wiki, one file per tiddler, so a wiki can be rebuilt from it in a new bucket or a new account: do [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit) with an empty bucket, clone the backup, and drag its files onto the admin wiki, like an existing wiki's file ([2.8](#28-the-first-visit)).

The admin wiki knows these files: TiddlyWiki's own JSON import keeps only text fields, and a stored tiddler has its tags as a list, so dropped onto any other TiddlyWiki they would lose every tag; the admin wiki's restore-import module turns them back into tiddlers, tags included, without the old revision, bag and recipe.

Every tiddler is then saved again, plugins included, each created anew and backed up. A thousand tiddlers take a few minutes to save and, at GitHub's pace, a couple of hours to commit ([limits 5](limits.md)).

For a whole clone, rather than dropping a thousand files, `node tools/restore.mjs <the clone>` (from a clone of this repository, Node 22) merges them into one `restore.json`, which you drag instead; it also makes a file any TiddlyWiki imports, and a single-file wiki out of a backup, for reading it anywhere: `npx tiddlywiki@5.4.1 wiki --init empty && npx tiddlywiki@5.4.1 wiki --load restore.json --build index` makes `wiki/output/index.html`.

To get back one tiddler, or one of its past versions: download its file from GitHub (its history has every version) and drop it onto the admin wiki.

## 2.5 The worker

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
   | `PUBLIC_WIKI_URL` | *(public site only)* the public site's address, `https://` and the bucket's custom domain ([2.2](#22-the-bucket-and-the-public-site)), nothing after the hostname. The page loads its plugin files and TiddlyWiki's core from it, and the admin wiki reads tiddlers from it. **Leave it out for a private wiki:** the worker then serves all of that itself. Set wrongly — an address that isn't a site's, an `http://` one (the admin site is https, and a browser won't load the core file into its page from an http address), or the worker's own — every request answers `500` saying so. Set before the domain answers ([2.2](#22-the-bucket-and-the-public-site)), the admin wiki can't publish its page until it does, and says so; the wiki starts from the engine meanwhile. Changed later, or removed, it works the same way as setting it: the next page load rebuilds the page from the engine, and the admin wiki publishes it again for the new address. Removed, it doesn't make the wiki private: the bucket's custom domain serves the wiki until it's removed from the bucket ([operating 3.23](operating.md#323-making-a-public-wiki-private-or-changing-its-domain)). |
   | `CF_ZONE_ID` | *(public site only)* the zone ID of the public site's domain (on the domain's overview page), for the public site's purges |
   | `CF_API_TOKEN` | *(public site only) secret:* an API token (**My Profile → API Tokens**) with *Zone → Cache Purge* on that zone. Without it and `CF_ZONE_ID`, no purges. |
   | `GITHUB_REPO`, `GITHUB_BRANCH` | `owner/repo` of the backup repository ([2.4](#24-the-backup-repository-optional)), and its branch (default `main`) |
   | `GITHUB_TOKEN` | *secret:* the token of 2.4. Without it and `GITHUB_REPO`, no backups. |
   | `CONFLICT_GUARD` | `off` builds the page without the browser modules ([operating 3.19](operating.md#319-the-browser-modules-off-and-checking-theyre-on)). (The wiki's own settings for those modules live in the plugin's settings tab, [operating 3.17](operating.md#317-the-plugin-and-its-settings).) |
   | `BACKUP_RETRY_SECONDS` | the first wait before a failed backup is tried again (default 60). |
   | `BACKUP_ALERT_MINUTES` | how long backups have to keep failing before the admin wiki shows it (default 60, [design 1.7](design.md#17-github-backup)). |
   | `ACCESS` | `off` lets requests through that didn't come through Cloudflare Access ([2.6](#26-cloudflare-access)), for the tests and local runs: only requests to a local address (`localhost`, `127.0.0.1`), so on a deployed worker it changes nothing. |

   Saving a variable deploys it at once; the first page load after that uses it.
4. The first deploy runs when you push, or at once if the dashboard offers it. The worker then answers at `https://wiki-admin.<your subdomain>.workers.dev` (your account's `workers.dev` subdomain is shown under Workers & Pages); that's the admin site, once Access protects it ([2.6](#26-cloudflare-access)).

**A custom domain for the admin site** (`admin.wiki.example.com`, say) instead of the `workers.dev` address, if you have a domain: add it under the worker's **Settings → Domains & Routes** (Cloudflare creates the DNS record), and use it in the CORS rule ([2.7](#27-the-zones-rules-public-site-only)) and in Access ([2.6](#26-cloudflare-access)). Or put it in `wrangler.toml` (the `routes` block in comments) if you'd rather have it in the repository; then set `workers_dev = false` there, so the worker has one address.

**Without Workers Builds,** two other ways work: `npx wrangler deploy` from your computer, after `npm install` and `npm run build`, with the same `wrangler.toml` and the settings in the dashboard; or pasting `worker.js` into the dashboard's editor, in which case you add the bindings of `wrangler.toml` by hand in the worker's settings too, and the empty wiki ([2.8](#28-the-first-visit)), since a pasted worker carries no asset.

## 2.6 Cloudflare Access

Cloudflare Access is the admin site's only lock: the worker has no login of its own. In the Cloudflare dashboard (October 2026): **Workers & Pages → the worker → the Access tab → Protect this Worker behind Access**, then **All traffic** (not *Previews only*, which would leave the `workers.dev` address and a custom domain open), a policy (below), and *Apply Access*. That one application covers every address of the worker: its `workers.dev` address, a custom domain ([2.5](#25-the-worker)) and its preview URLs, which `wrangler.toml` turns off anyway. Requests Access blocks never reach the worker, so they cost no quota. The first time an account uses Zero Trust, Cloudflare asks for a team name, which becomes the address of the login page (`<team>.cloudflareaccess.com`), and a plan: the Free one, which asks for payment details all the same and charges nothing.

**The policy** says who gets in; whoever matches none is denied. The tab offers two: *Cloudflare account*, the members of your Cloudflare account, you alone on an account you haven't added anyone to, which is the one to pick; and *Email domain*, every verified address at a domain you enter, which with a shared domain (`gmail.com`, say) admits everyone with an address there: not that one. For one address exactly, make a policy under **Zero Trust → Access → Policies**, *Include → Emails* with your address, and select it in the tab as an existing policy.

**Logging in:** the login page asks you to sign in with your Cloudflare account, the default method of an organisation made since June 2026, or, with the one-time PIN method turned on (Zero Trust → Integrations → Identity providers), sends a code to your e-mail, valid ten minutes.

The worker refuses any request that didn't come through Access (`403`, before reading or building anything), so a missing application, or one covering another hostname than the one a request came to, leaves the wiki closed rather than open; the refusal names the address and says what to do ([design 1.18](design.md#118-cloudflare-access)). *Check the setup* ([operating 3.15](operating.md#315-checking-the-setup)) names whom Access let in, and says the policy itself isn't checked: look at it once, in the tab. Only the tests and local runs, where there is no Access, switch the check off with `ACCESS = off`, and the switch counts only for a request to a local address (`localhost`, `127.0.0.1`): left on by mistake on a deployed worker, it opens nothing.

**Logging out:** *Logout* in the cloud icon's dropdown (the "Server status" button in the sidebar) goes to Access's own logout page, `/cdn-cgi/access/logout` on the admin site, which ends the session and shows the login page again; the worker has no session of its own to end. It ends the Access session only: the device copy (every tiddler loaded on this device), the outbox and the service worker's page stay in this browser, and with no network, or one slower than the network wait ([operating 3.13](operating.md#313-opening-the-wiki-offline)), the admin address opens the wiki from them, readable and editable, for whoever uses the browser next; tapped offline, *Logout* itself reloads the wiki in place, the cached page answering. On a computer that isn't yours, use a private window, which keeps nothing once closed; or, with nothing waiting in the outbox (the cloud icon isn't red), log out and then clear the admin site's data in the browser's settings. *Forget this device's copy* before *Logout* doesn't do it: its reload fills the copy again ([operating 3.18](operating.md#318-this-device)).

**The session's length** is the application's *Session duration* (a day by default, up to a month). A tab left open past it is told, in the cloud icon's dropdown, that the login has expired and how to log in again, with every change kept on the device meanwhile ([operating 3.14](operating.md#314-when-your-login-expires)).

## 2.7 The zone's rules *(public site only)*

Under your domain, in the dashboard. Each rule names the public hostname, so `/` on other hostnames of the zone isn't rewritten, and nothing else is cached by these rules.

**A URL rewrite** (Rules → Transform Rules → Rewrite URL), so the public site opens on the built page:
- **When:** `http.host eq "wiki.example.com"` and `http.request.uri.path eq "/"`
- **Then:** rewrite the path to `/baked.html`

**Cache rule "Cache public wiki":**
- **When:** `http.host eq "wiki.example.com"`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** ignore the cache-control header and use a TTL. R2 sends none, and every change made through the worker is purged right away once `CF_ZONE_ID` and `CF_API_TOKEN` are set ([2.5](#25-the-worker)); until then, a change shows on the public site when this TTL runs out, and *Check the setup* says so ([operating 3.15](operating.md#315-checking-the-setup)). One day is a safe default; longer works too, but a missed purge or a file uploaded to R2 by hand then stays stale that long.
- **Browser TTL:** override with something short, for example 5 minutes. Purges can't reach visitors' browsers, and without this Cloudflare's default of 4 hours applies.
- **Serve stale content while revalidating:** off.
- **Cache key:** the defaults. The query string must stay in the key, because purges target exact URLs ([design 1.6](design.md#16-public-cache-purges)).

**Cache rule "Cache plugin files"**, placed *after* the one above (when several rules match, the last one wins):
- **When:** `http.host eq "wiki.example.com"` and `starts_with(http.request.uri.path, "/_plugins/")`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** use the cache-control header if present, Cloudflare's default if not. Plugin files carry `Cache-Control: public, max-age=31536000, immutable`.
- **Browser TTL:** respect origin
- **Cache key:** the defaults. The query string (`?v=<revision>`) must stay in the key: it's what makes each version a new URL.

Plugin files are never purged: each version has its own URL ([design 1.8](design.md#18-plugins-and-javascript-modules)). Without this rule they follow "Cache public wiki", which still works, but browsers re-check them every few minutes. TiddlyWiki's core file, `_plugins/tiddlywikicore.js`, is under the same path, with the same caching.

**Cache rule "Cache status file"** (optional), also placed after "Cache public wiki":
- **When:** `http.host eq "wiki.example.com"` and `http.request.uri.path eq "/status"`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** ignore the cache-control header and use a TTL of 7 days (the file never changes)
- **Browser TTL:** override with 7 days

Public tabs ask for `/status` at every page load, before the tiddler list. With this rule a visitor's browser asks once a week; without it, "Cache public wiki" applies and it asks again after a few minutes.

**Response header transform rule "CORS for the admin wiki"** (Rules → Transform Rules → Modify Response Header):
- **When:** `http.host eq "wiki.example.com" and (starts_with(http.request.uri.path, "/recipes/") or starts_with(http.request.uri.path, "/_plugins/"))`
- **Then:** set the static header `Access-Control-Allow-Origin` to the admin site's origin, `https://wiki-admin.<your subdomain>.workers.dev` (or `https://admin.wiki.example.com` with a custom domain; no trailing slash)

This lets the admin wiki read tiddler contents from the public site ([design 1.5](design.md#15-keeping-worker-requests-down), [2.9](#29-a-second-wiki)), and keep the core and plugin files for opening offline ([operating 3.13](operating.md#313-opening-the-wiki-offline)). Without it everything still works online, but every tiddler is fetched through the worker, and the files aren't kept: a rule set before the `/_plugins/` path was part of it needs that path added.

A "Bypass cache" rule for the admin hostname is optional: Cloudflare never caches responses a worker generates itself.

## 2.8 The first visit

Open the admin site (`https://wiki-admin.<your subdomain>.workers.dev`, or your custom domain). Access asks you to log in (with your Cloudflare account, or a code sent to your e-mail, [2.6](#26-cloudflare-access)), then the worker puts an empty TiddlyWiki in the bucket as `index.html` (the engine; your content lives in the tiddler files) with the public site's `status` file (written for a private wiki too, for the day it gets a public site), builds the page, and the wiki opens. That first load also publishes TiddlyWiki's core file and the page, for both sites. With a public site, open `https://wiki.example.com` to see it. Then Control Panel → Saving → Cloudflare → *Check the setup* looks at each piece (Access, the public site's rules, backups, the queue, purges) and, for one that's missing, says what to do and names the section of this guide with the full steps ([operating 3.15](operating.md#315-checking-the-setup)).

With backups set up ([2.4](#24-the-backup-repository-optional)), save one tiddler next and look for its commit in the backup repository a minute later: the check tells whether GitHub accepts the token and finds the repository and its branch, not whether the token may write there, which the first backup shows (the admin wiki's alert says so after an hour if it doesn't, [troubleshooting 4](troubleshooting.md)). Then import.

**An existing wiki:** drag its `.html` file onto the admin wiki. TiddlyWiki's import saves every tiddler, plugins included, and each goes to R2 and to the backup. With a public site, each is readable there by anyone the moment it's saved, and a public backup repository keeps it in its history after a delete. To publish part of a wiki only, export that part from the old wiki first (Advanced search → Filter, its export button) and import the export; or import the whole while the wiki is still private, delete what stays private, then add the public site ([operating 3.22](operating.md#322-making-a-private-wiki-public)). Don't upload your wiki as `index.html` instead: TiddlyWiki deletes, at the first sync, every tiddler the page came with that the server doesn't list, so the content would vanish from view, and the file itself would be public.

**A big wiki,** more than about 1,500 tiddlers: import it before backups are set up, and run one full backup after. A save's backup is 3 of the free plan's 10,000 queue operations a day, more when GitHub's rate limit (about 500 commits an hour) makes the queue deliver it again, so an import of 3,000 tiddlers spends the day's operations before it's through; past them the queue takes no more messages, each save's backup runs directly, three quick tries GitHub's rate limit refuses, and nothing retries them ([limits 5](limits.md)). So leave `GITHUB_REPO` and `GITHUB_TOKEN` unset ([2.5](#25-the-worker)) until the import is done, then set them and run *Back up everything to GitHub* once ([2.4](#24-the-backup-repository-optional)): 3 operations per step of about 20 tiddlers. Until it finishes, the bucket is the only copy.

**A pasted worker** (`worker.js` alone, without the empty wiki, [2.5](#25-the-worker)): upload `seed/empty.html` (made by `npm run build`) to the bucket as `index.html`, and a file `status` with this content, the TiddlyWeb status for the public site (without it, public tabs don't know the recipe and can't load the tiddler list):

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

## 2.9 A second wiki

A second wiki is a second worker with its own bucket, queue, settings and, if public, its own public site: steps [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit) again with other names. From one repository, Wrangler environments do it: an `[env.notes]` section in `wrangler.toml` with that wiki's `name`, bucket and queue (and route, with a custom domain), deployed with `npx wrangler deploy --env notes` (as the deploy command of a second Workers Builds project, or from your computer); its settings go in that worker's dashboard like the first one's. The zone rules are per hostname, so each wiki gets its own set, and `CF_ZONE_ID` and `CF_API_TOKEN` can be shared. The free plan's limits ([limits 5](limits.md)) are per account, whichever way the wikis are deployed.

