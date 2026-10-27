# 2. Setting up

*Chapter 2 of the [manual](../README.md#the-manual). Each step names what the next ones need. The names used here — the engine, the page, the device copy, the outbox, the plugin — are in [chapter 1](../README.md#the-names).*

About ten minutes, in this order.

## 2.1 Before you start

**A private wiki, or a public one.** Choose first: each path has its sections.

| | A private wiki | A public wiki |
|---|---|---|
| What it is | the admin site alone, behind Access, at the worker's own address; nothing in the bucket reachable by anyone else | the same, plus the public site: the bucket's custom domain, where every tiddler you save is readable by anyone at once |
| The sections | [2.2](#22-the-bucket-and-the-public-site) (the bucket alone), [2.3](#23-the-backup-queue), [2.4](#24-the-backup-repository-optional) (optional; a private repository), [2.5](#25-the-worker) (without `PUBLIC_WIKI_URL`, `CF_ZONE_ID` and `CF_API_TOKEN`), [2.6](#26-cloudflare-access), [2.8](#28-the-first-visit); the steps marked *(public site only)* don't apply | [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit), the steps marked *(public site only)* included |
| It takes | about five minutes | about ten, and a domain added to the account as a zone (below) |

A private wiki's first load on a new device reads every tiddler from the worker, then only what changed ([limits 5](limits.md)). It can be made public later, in the order of [operating 3.22](operating.md#322-making-a-private-wiki-public): the admin site doesn't move, but everything written so far becomes public with the domain, so what shouldn't be is deleted first, or moved to a second wiki that stays private (2.9).

**By hand, from a fork:**

1. **Fork this repository** on GitHub. Cloudflare deploys the worker from the fork's `main` branch, and from then on every push to it deploys; nothing in the fork is edited, so an update is GitHub's *Sync fork* ([operating 3.1](operating.md#31-updating-your-copy)).
2. **Do [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit) in order,** with the names below, which apply throughout.

The names, and where each goes. With the defaults, nothing in the repository needs editing: the worker is deployed as it is, and your settings are entered in the dashboard ([2.5](#25-the-worker)). A public site by hand: have the zone, its ID and the purge token before [2.5](#25-the-worker), and for backups the repository and its token ([2.4](#24-the-backup-repository-optional)); the rows marked *(public site only)* and *(optional)* say which.

| Name | Default or example | Where it goes |
|---|---|---|
| the zone *(public site only)* | `example.com`, yours, added to the Cloudflare account ([2.2](#22-the-bucket-and-the-public-site)) | your domain as a site of the account: the public site, and the admin site's custom domain if any, are hostnames of it, and the rules of [2.7](#27-the-zones-rules-public-site-only) live under it |
| the public site *(public site only)* | `wiki.example.com`, yours | the bucket's custom domain ([2.2](#22-the-bucket-and-the-public-site)), the setting `PUBLIC_WIKI_URL` ([2.5](#25-the-worker)) and the zone rules ([2.7](#27-the-zones-rules-public-site-only)) |
| the zone ID *(public site only)* | on [the domain's overview page](https://dash.cloudflare.com/?to=/:account/:zone) in the dashboard | the setting `CF_ZONE_ID` ([2.5](#25-the-worker)) |
| the purge token *(public site only)* | a custom API token with *Zone → Cache Purge* on that zone, made before [2.5](#25-the-worker), which has the steps | the `CF_API_TOKEN` secret ([2.5](#25-the-worker)) |
| the backup repository and its token *(optional)* | [2.4](#24-the-backup-repository-optional) | the setting `GITHUB_REPO` and the `GITHUB_TOKEN` secret ([2.5](#25-the-worker)) |
| the admin site | `wiki-admin.<your subdomain>.workers.dev` | the worker's own address, behind Access ([2.6](#26-cloudflare-access)), allowed by the CORS rule ([2.7](#27-the-zones-rules-public-site-only)); a custom domain instead, if you like ([2.5](#25-the-worker)) |
| the bucket | `wiki` | [2.2](#22-the-bucket-and-the-public-site); `wrangler.toml` if you name it otherwise |
| the queue | `wiki-backup` | [2.3](#23-the-backup-queue); `wrangler.toml` if you name it otherwise |
| the worker | `wiki-admin` | the name you give it in [2.5](#25-the-worker); `wrangler.toml` if you name it otherwise |

`wrangler.toml` holds the bindings and the defaults above; its comments say what each is for. No secret goes in it, ever: the two secrets are entered in [2.5](#25-the-worker), with the settings.

## 2.2 The bucket and the public site

1. In the Cloudflare dashboard, under **[R2](https://dash.cloudflare.com/?to=/:account/r2/overview)**, create the bucket (`wiki`). Nothing to upload: the worker fills it on the first visit ([2.8](#28-the-first-visit)). For a private wiki, that's all: leave public access off, and **Public Development URL (`r2.dev`)** disabled.

   *(public site only)* **The domain first.** R2 connects only a domain that is a zone of the same Cloudflare account, *Active*: a domain added to the account ([Cloudflare's steps](https://developers.cloudflare.com/fundamentals/manage-domains/add-site/): add the site, review the DNS records it imports, your mail ones among them, and set Cloudflare's nameservers at your registrar), which can take hours, so start it before anything else. The public site is a hostname of it, `wiki.example.com` under `example.com`: pick one with no DNS record of its own yet, since connecting the bucket creates it. The custom domain shows *Initializing* before *Active* ([reference 7](reference.md)). The admin site needn't move: it stays at its `workers.dev` address.
2. *(public site only)* In the bucket's settings, turn on public access. Everything in the bucket is public through the domain from the moment it's connected, every tiddler, the tiddler list and the page, and for a wiki that was private, everything written so far ([operating 3.22](operating.md#322-making-a-private-wiki-public)). That's intended: nothing private belongs in a public wiki's bucket (secrets live in the worker's settings). Then:
   - **Custom Domains:** connect `wiki.example.com`.
   - **Public Development URL (`r2.dev`):** keep it disabled. It's a second public address that skips the zone's cache and rules.
   - **CORS Policy:** leave it empty. A transform rule handles CORS instead ([2.7](#27-the-zones-rules-public-site-only)).

   Wait for the domain before going on. Custom Domains shows it *Initializing*, then *Active*, within a few minutes (refresh the page to see it change; if it stays, *Retry connection* in the domain's menu). Then open `https://wiki.example.com/status` in a browser: a page from R2 means the domain answers (a 404, *Object not found*, while the bucket is empty; the status file's JSON after the first visit), while a connection error or an error page from Cloudflare means not yet. Set `PUBLIC_WIKI_URL` ([2.5](#25-the-worker)) only then: set while the domain doesn't answer, the admin wiki can't publish its page, and says so until the site does; *Check the setup* run meanwhile says the site answered 530, Cloudflare's edge with no bucket behind the host yet, and to check again in a few minutes ([operating 3.15](operating.md#315-checking-the-setup)). The domain goes on the bucket the worker is bound to, the one `wrangler.toml` names (`wiki`, unless you changed `bucket_name`): on another bucket, the site answers but serves nothing of the wiki, and the check says so.

## 2.3 The backup queue

Under **[Storage & Databases → Queues](https://dash.cloudflare.com/?to=/:account/workers/queues)**, create the queue (`wiki-backup`). That's all: the deploy ([2.5](#25-the-worker)) binds the worker to it as its producer and consumer, with the settings in `wrangler.toml` (batches of 10, 5 seconds, one at a time, 3 retries). Don't lower the retries: the worker counts on them for its waits ([design 1.7](design.md#17-github-backup)).

Create the queue before the worker's first deploy ([2.5](#25-the-worker)): Wrangler refuses to deploy while a queue named in `wrangler.toml` doesn't exist. A worker without the queue binding (pasted into the dashboard without it, [2.5](#25-the-worker)) runs the same backup directly after each save, with a couple of quick retries but no long-term waiting.

## 2.4 The backup repository (optional)

- **A repository of its own** for the backup, one per wiki, created with *Add a README file* ticked, so its `main` branch exists (a repository with no commit has no branch, and *Check the setup* looks for it); the backup's files go in `tiddlers/`, and the README stays. Put three lines in that README, for whoever finds the repository on the day it matters: what it is (the backup of a TiddlyWiki on Cloudflare, one file per tiddler under `tiddlers/`), the project's address (https://github.com/DesignThinkerer/tiddlywiki-cloudflare), and how to restore it ("setup 2.4's procedure: the admin wiki's import, or `tools/restore.mjs`; never a plain TiddlyWiki import, which drops every tag"). **Private, for a private wiki:** a public repository publishes every save, with its history, for anyone to read, and *Check the setup* says so ([operating 3.15](operating.md#315-checking-the-setup)); for a public wiki, as you like. Never use the repository the worker is deployed from: its token would let anyone who got it change the worker's code.
- **A fine-grained personal access token** limited to that repository, with *Contents: read and write*. [This link](https://github.com/settings/personal-access-tokens/new?name=wiki+backup&description=One+commit+per+save+into+the+backup+repository+%28tiddlywiki-cloudflare%2C+setup+2.4%29&expires_in=366&contents=write) opens GitHub's form with the name, the permission and the longest expiry the form allows (a year) filled in; what's left is *Repository access → Only select repositories* → the backup repository, then *Generate token*. You'll store it as the `GITHUB_TOKEN` secret ([2.5](#25-the-worker)). **Renewing the token:** it lasts a year, and GitHub e-mails you before it expires; *Check the setup* shows the date on its backups line, and within a month of it says to renew. On GitHub (Settings → Developer settings → Personal access tokens → Fine-grained tokens → the token), choose *Regenerate token*: it keeps the repository and the permission; set the expiry to a year with a custom date, since the form's default is shorter; then put the new value in the worker's `GITHUB_TOKEN` secret. Done before the date, no backup fails; after it, the same steps, and the waiting backups go through by themselves (the admin wiki shows the backup alert, `Bad credentials`, meanwhile; [troubleshooting 4](troubleshooting.md)).

Without a repository and a token, the worker skips backups: the wiki then has no history, since the bucket keeps the current version of each tiddler alone, and a deletion or an overwrite is final.

**A wiki that already has content** when backups are set up — an imported wiki, say — has nothing on GitHub until a **full backup** runs: the admin wiki reminds you once, and the button is in the Control Panel → Saving → **Cloudflare** tab, *Back up everything to GitHub*. For a big wiki, more than about 1,500 tiddlers, that's the cheaper order anyway: import first, then set the repository and the token ([2.8](#28-the-first-visit)).

It makes GitHub mirror the wiki: every stored tiddler GitHub doesn't have, or has differently, is committed, and files of tiddlers no longer in the wiki are removed; run again, it changes nothing.

It runs in the backup queue, without the tab, at GitHub's pace (about 500 commits an hour), and the tab shows its progress (as of its last minute's refresh, or *Refresh the status*). Run it once after setting backups up, after a restore (below), after putting a tiddler in the bucket by hand, or in any doubt.

**Restoring from the backup.** The backup is the wiki, one file per tiddler, so a wiki can be rebuilt from it in a new bucket or a new account:

1. **A new bucket:** [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit), the bucket empty.
2. **Clone the backup,** on Linux, macOS or WSL: the file names hold `:`, which Windows refuses, so a clone there lacks every system tiddler ([limits 5](limits.md)).
3. **Make one file of it:** `node tools/restore.mjs <the clone>`, from a clone of this repository or of your fork (Node 22). It merges the files into `restore.json`, refuses an empty folder, names each tiddler the commit has and the disk doesn't and reads it from the commit (git is asked; a download that isn't a clone is taken as it is), and on Windows says so first. Check its count: the full backup that follows removes from the branch whatever the restore missed.
4. **Drag `restore.json` onto the admin wiki,** or choose it with the Tools tab's *Import* button. Every tiddler is then saved again, plugins included, each created anew and backed up: a thousand tiddlers take a few minutes to save and, at GitHub's pace, a couple of hours to commit ([limits 5](limits.md)).
5. **A full backup** (above, [operating 3.2](operating.md#32-a-full-backup)), after the restore file is dropped, never before: on an empty wiki, a full backup makes GitHub mirror the empty bucket and removes every file of the backup (the admin wiki's hint about it doesn't show on an empty wiki, for that reason).

Dragging the clone's files themselves onto the admin wiki, or importing them with the Tools tab's button, works too (the admin wiki knows these files: TiddlyWiki's own JSON import keeps only text fields, and a stored tiddler has its tags as a list, so dropped onto any other TiddlyWiki they would lose every tag; the admin wiki's restore-import module turns them back into tiddlers, tags included, without the old revision, bag and recipe), but a thousand files with `$:/` and slashed titles in subfolders are better merged first. The tool also makes a file any TiddlyWiki imports, and a single-file wiki out of a backup, for reading it anywhere: `npx tiddlywiki@5.4.1 wiki --init empty && npx tiddlywiki@5.4.1 wiki --load restore.json --build index` makes `wiki/output/index.html`.

**One tiddler, or one of its past versions:** the *History on GitHub* button in the tiddler's toolbar opens its file's history (the button is off by default: Control Panel → Appearance → Toolbars → View Toolbar; the file is `tiddlers/<title>.json`, each slash of the title a folder); download the version you want and drop it onto the admin wiki, or import it with the Tools tab's button. The Cloudflare tab's *Backups* section links the repository's commits.

## 2.5 The worker

The worker is deployed from your repository by Cloudflare's **Workers Builds**: every push to `main` builds `worker.js` and deploys it, with the bindings and settings from `wrangler.toml`.

1. Under **[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)**, create the worker from your repository (**Create → Import a repository**, or for a worker that already exists, its **Settings → Builds → Connect**). Cloudflare's GitHub app needs access to that repository. Name the worker `wiki-admin`: the name must be the `name` in `wrangler.toml`.
2. The build settings:
   - **Production branch:** `main`.
   - **Build command:** `npm run build`. It writes `worker.js` and `seed/empty.html`, the empty wiki a new bucket starts from, which the deploy uploads with the worker (as a text module of it: `wrangler.toml`).
   - **Deploy command:** the default, `npx wrangler deploy`.
   - **Builds for non-production branches:** off. A branch's preview would use the real bucket and queue.
   - **Build watch paths:** include only `src/*`, `build.mjs`, `tools/*`, `package.json`, `package-lock.json` and `wrangler.toml`, so a change to the README, or anything else, doesn't deploy.
3. **The settings and the secrets,** under the worker's **Settings → Variables and Secrets**. A deploy keeps them all (`keep_vars` in `wrangler.toml`), so nothing of yours is in the repository. The settings can be plain variables or secrets, as you prefer; the two tokens must be secrets — in the dialog, choose the type *Secret*: its default, *Text*, shows the value to anyone who opens the settings. Three for a public site, two for backups, one of each a secret; the rest stay unset. A private wiki without backups needs none.

   **For a public site** *(public site only)*:

   | Name | What |
   |---|---|
   | `PUBLIC_WIKI_URL` | the public site's address, `https://` and the bucket's custom domain ([2.2](#22-the-bucket-and-the-public-site)), nothing after the hostname. Leave it out for a private wiki. |
   | `CF_ZONE_ID` | the zone ID of the public site's domain, on [the domain's overview page](https://dash.cloudflare.com/?to=/:account/:zone), for the purges. |
   | `CF_API_TOKEN` | *secret:* the purge token, made as follows. Without it and `CF_ZONE_ID`, no purges. |

   **The purge token,** step by step: **[My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Create Token**, then *Create Custom Token*; a name; under *Permissions*, one row, *Zone*, *Cache Purge*, *Purge*; under *Zone Resources*, *Include*, *Specific zone*, the public site's domain; a TTL as you like (when it ends, *Check the setup* says Cloudflare refused the purge: make a new one the same way and replace the secret); *Continue to summary*, then *Create Token*; copy it now, it's shown once, and paste it as the `CF_API_TOKEN` secret. A template token would work, but hands the worker more than a wiki should hold ([design 2.31](design.md#231-removing-a-wiki-the-dashboard-not-the-plugin)); Cloudflare documents no prefilled link for a custom token.

   **For backups** *(optional)*:

   | Name | What |
   |---|---|
   | `GITHUB_REPO` | `owner/repo` of the backup repository ([2.4](#24-the-backup-repository-optional)). |
   | `GITHUB_TOKEN` | *secret:* the token of 2.4. Without it and `GITHUB_REPO`, no backups. |
   | `GITHUB_BRANCH` | its branch, only if it isn't `main`. |

   **Leave unset** (defaults; for tuning, and the tests):

   | Name | What |
   |---|---|
   | `CONFLICT_GUARD` | `off` builds the page without the plugin, *TiddlyWiki on Cloudflare*: no conflict protection, no device copy or offline editing, no backup alert, no Cloudflare tab, and the page is no longer published ([operating 3.19](operating.md#319-turning-the-plugin-off-and-checking-its-on)). (The wiki's own settings live in the plugin's settings tab, [operating 3.17](operating.md#317-the-plugin-and-its-settings).) |
   | `BACKUP_RETRY_SECONDS` | the first wait before a failed backup is tried again (default 60). |
   | `BACKUP_ALERT_MINUTES` | how long backups have to keep failing before the admin wiki shows it (default 60, [design 1.7](design.md#17-github-backup)). |
   | `ACCESS` | `off` lets requests through that didn't come through Cloudflare Access, for the tests and local runs only ([2.6](#26-cloudflare-access)). |

   `PUBLIC_WIKI_URL` is where the page loads its plugin files and TiddlyWiki's core from, and where the admin wiki reads tiddlers from; left out, the worker serves all of that itself. Set wrongly — an address that isn't a site's, an `http://` one (the admin site is https, and a browser won't load the core file into its page from an http address), or the worker's own — every request answers `500` saying so. Set before the domain answers ([2.2](#22-the-bucket-and-the-public-site)), the admin wiki can't publish its page until it does, and says so; the wiki starts from the engine meanwhile. Changed later, or removed, it works the same way as setting it: the next page load rebuilds the page from the engine, and the admin wiki publishes it again for the new address. Removed, it doesn't make the wiki private: the bucket's custom domain serves the wiki until it's removed from the bucket ([operating 3.23](operating.md#323-making-a-public-wiki-private-or-changing-its-domain)).

   Saving a variable deploys it at once; the first page load after that uses it.
4. The first deploy runs when you push, or at once if the dashboard offers it. The worker then answers at `https://wiki-admin.<your subdomain>.workers.dev` (your account's `workers.dev` subdomain is shown under Workers & Pages); that's the admin site, once Access protects it ([2.6](#26-cloudflare-access)).

**A custom domain for the admin site** (`admin.wiki.example.com`, say) instead of the `workers.dev` address, if you have a domain: add it under the worker's **Settings → Domains & Routes** (Cloudflare creates the DNS record), and use it in the CORS rule ([2.7](#27-the-zones-rules-public-site-only)) and in Access ([2.6](#26-cloudflare-access)). Or put it in `wrangler.toml` (the `routes` block in comments) if you'd rather have it in the repository; then set `workers_dev = false` there, so the worker has one address. A public site needs none of this. Changing the address later has an order that loses nothing ([operating 3.25](operating.md#325-changing-the-admin-sites-address)). Moving the admin site later is a new site to each browser: let each device's waiting changes go out first; the device copy and the service worker start again, an installed app is installed again ([operating 3.16](operating.md#316-installing-the-wiki-as-an-app)), and the CORS rule and Access follow the new address.

**Without Workers Builds,** two other ways work: `npx wrangler deploy` from your computer, after `npm install` and `npm run build`, with the same `wrangler.toml` and the settings in the dashboard; or pasting `worker.js` into the dashboard's editor, in which case you add the bindings of `wrangler.toml` by hand in the worker's settings too, and the empty wiki ([2.8](#28-the-first-visit)), since a pasted worker carries no asset.

## 2.6 Cloudflare Access

Cloudflare Access is the admin site's only lock: the worker has no login of its own. In the Cloudflare dashboard (October 2026): **[Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → the worker → the Access tab → Protect this Worker behind Access**, then **All traffic** (not *Previews only*, which would leave the `workers.dev` address and a custom domain open), a policy (below), and *Apply Access*. That one application covers every address of the worker: its `workers.dev` address, a custom domain ([2.5](#25-the-worker)) and its preview URLs, which `wrangler.toml` turns off anyway. Requests Access blocks never reach the worker, so they cost no quota. The first time an account uses Zero Trust, Cloudflare asks for a team name, which becomes the address of the login page (`<team>.cloudflareaccess.com`), and a plan: the Free one, which asks for payment details all the same and charges nothing.

**The policy** says who gets in; whoever matches none is denied. The tab offers two: *Cloudflare account*, the members of your Cloudflare account, you alone on an account you haven't added anyone to, which is the one to pick; and *Email domain*, every verified address at a domain you enter, which with a shared domain (`gmail.com`, say) admits everyone with an address there: not that one. For one address exactly, or a few, make a policy under **Zero Trust → Access → Policies**, *Include → Emails* with the addresses, and select it in the tab as an existing policy.

**Sharing the admin wiki** with a few people you trust is that policy with their addresses in its *Emails* rule, one each; nothing else changes. Not *Email domain* (everyone at that provider), and not members of your Cloudflare account (that is your dashboard, the bucket and the worker's settings, not the wiki): the policy's list is the whole of who can edit. A guest logs in with the one-time PIN method (below), a code sent to their address, no Cloudflare account needed, for a session that lasts the application's *Session duration*. What they get is the wiki as you have it: everyone Access admits is the owner, with no roles, so a guest edits and deletes, installs plugins, updates the engine and publishes the public page as you do ([design 1.18](design.md#118-cloudflare-access)). The bucket keeps the current version of each tiddler alone, so set the backups up first ([2.4](#24-the-backup-repository-optional)): GitHub is the history, committed under the worker's token, which names no editor; Access's own logs say who logged in. Two people editing the same tiddler get a conflict copy, as two of your devices do ([operating 3.20](operating.md#320-when-two-tabs-edit-the-same-tiddler)), and a guest's offline changes wait on their device until it's back online and open ([3.11](operating.md#311-editing-offline)). To take access back, remove the address from the policy, then end the session already open, which would otherwise last until the *Session duration* runs out: **Zero Trust → Team & Resources → Users**, the person, *Action → Revoke*; their next login is refused within a minute. Their device keeps the copy of the wiki it loaded, as yours does after *Logout* (below): revoking access takes nothing back.

**Logging in:** the login page asks you to sign in with your Cloudflare account, the default method of an organisation made since June 2026, or, with the one-time PIN method turned on ([Zero Trust](https://dash.cloudflare.com/) → Integrations → Identity providers), sends a code to your e-mail, valid ten minutes.

The worker refuses any request that didn't come through Access (`403`, before reading or building anything), so a missing application, or one covering another hostname than the one a request came to, leaves the wiki closed rather than open; the refusal names the address and says what to do ([design 1.18](design.md#118-cloudflare-access)). *Check the setup* ([operating 3.15](operating.md#315-checking-the-setup)) names whom Access let in, and says the policy itself isn't checked: look at it once, in the tab. Only the tests and local runs, where there is no Access, switch the check off with `ACCESS = off`, and the switch counts only for a request to a local address (`localhost`, `127.0.0.1`): left on by mistake on a deployed worker, it opens nothing.

**Logging out:** *Logout* in the cloud icon's dropdown (the "Server status" button in the sidebar) goes to Access's own logout page, `/cdn-cgi/access/logout` on the admin site, which ends the session and shows the login page again; the worker has no session of its own to end. It ends the Access session only: the device copy (every tiddler loaded on this device), the outbox and the service worker's page stay in this browser, and with no network, or one slower than the network wait ([operating 3.13](operating.md#313-opening-the-wiki-offline)), the admin address opens the wiki from them, readable and editable, for whoever uses the browser next; tapped offline, *Logout* itself reloads the wiki in place, the cached page answering. On a computer that isn't yours, use a private window, which keeps nothing once closed; or, with nothing waiting in the outbox (the cloud icon isn't red), log out and then clear the admin site's data in the browser's settings. *Forget this device's copy* before *Logout* doesn't do it: its reload fills the copy again ([operating 3.18](operating.md#318-this-device)).

**The session's length** is the application's *Session duration* (a day by default, up to a month). For a wiki you edit offline, on a phone say, a longer session (a week, up to a month) lets your changes go as soon as the network is back, without a login first; a shorter one is safer on a device others can pick up. A tab left open past it is told, in the cloud icon's dropdown, that the login has expired and how to log in again, with every change kept on the device meanwhile ([operating 3.14](operating.md#314-when-your-login-expires)).

## 2.7 The zone's rules *(public site only)*

Under your domain, in the dashboard. Each rule names the public hostname, so `/` on other hostnames of the zone isn't rewritten, and nothing else is cached by these rules.

**A URL rewrite** ([Rules](https://dash.cloudflare.com/?to=/:account/:zone/rules/overview) → Transform Rules → Rewrite URL), so the public site opens on the built page:
- **When:** `http.host eq "wiki.example.com"` and `http.request.uri.path eq "/"`
- **Then:** rewrite the path to `/baked.html`

**Cache rule "Cache public wiki"** ([Rules → Cache Rules](https://dash.cloudflare.com/?to=/:account/:zone/caching/cache-rules)):
- **When:** `http.host eq "wiki.example.com"`
- **Cache eligibility:** eligible for cache
- **Edge TTL:** ignore the cache-control header and use a TTL. R2 sends none, and every change made through the worker is purged right away once `CF_ZONE_ID` and `CF_API_TOKEN` are set ([2.5](#25-the-worker)); a file uploaded by hand isn't ([operating 3.24](operating.md#324-images-and-files)); until then, a change shows on the public site when this TTL runs out, and *Check the setup* says so ([operating 3.15](operating.md#315-checking-the-setup)). One day is a safe default; longer works too, but a missed purge or a file uploaded to R2 by hand then stays stale that long.
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

**Response header transform rule "CORS for the admin wiki"** ([Rules](https://dash.cloudflare.com/?to=/:account/:zone/rules/overview) → Transform Rules → Modify Response Header):
- **When:** `http.host eq "wiki.example.com" and (starts_with(http.request.uri.path, "/recipes/") or starts_with(http.request.uri.path, "/_plugins/"))`
- **Then:** set the static header `Access-Control-Allow-Origin` to the admin site's origin, `https://wiki-admin.<your subdomain>.workers.dev` (or `https://admin.wiki.example.com` with a custom domain; no trailing slash)

This lets the admin wiki read tiddler contents from the public site ([design 1.5](design.md#15-keeping-worker-requests-down), [2.9](#29-a-second-wiki)), and keep the core and plugin files for opening offline ([operating 3.13](operating.md#313-opening-the-wiki-offline)). Without it everything still works online, but every tiddler is fetched through the worker, and the files aren't kept: a rule set before the `/_plugins/` path was part of it needs that path added.

A "Bypass cache" rule for the admin hostname is optional: Cloudflare never caches responses a worker generates itself.

## 2.8 The first visit

Open the admin site (`https://wiki-admin.<your subdomain>.workers.dev`, or your custom domain). Access asks you to log in (with your Cloudflare account, or a code sent to your e-mail, [2.6](#26-cloudflare-access)), then the worker puts an empty TiddlyWiki in the bucket as `index.html` (the engine; your content lives in the tiddler files) with the public site's `status` file (written for a private wiki too, for the day it gets a public site), builds the page, and the wiki opens. That first load also publishes TiddlyWiki's core file and the page, for both sites. With a public site, open `https://wiki.example.com` to see it. Then Control Panel → Saving → Cloudflare → *Check the setup* looks at each piece (Access, the public site's rules, backups, the queue, purges) and, for one that's missing, says what to do and names the section of this guide with the full steps ([operating 3.15](operating.md#315-checking-the-setup)). Every line is fine from the second load: at the first, the service worker takes its copy of the core file after the page has loaded, and the check's line about it says so and asks for one reload ([operating 3.13](operating.md#313-opening-the-wiki-offline)).

With backups set up ([2.4](#24-the-backup-repository-optional)), save one tiddler next and look for its commit in the backup repository a minute later: the check tells whether GitHub accepts the token and finds the repository and its branch, not whether the token may write there, which the first backup shows (the admin wiki's alert says so after an hour if it doesn't, [troubleshooting 4](troubleshooting.md)). Then import.

**Saving is automatic:** every change goes to the worker as you make it, and the cloud icon shows what waits; Ctrl+S says so rather than downloading a copy, and the cloud icon's *Save snapshot for offline use* is the way to a file ([operating 3.26](operating.md#326-your-wiki-as-one-file)).

**An existing wiki:** drag its `.html` file onto the admin wiki, or choose it with the sidebar's Tools tab → *Import* button (the way on a phone or tablet, where a page takes no dropped file). TiddlyWiki's import saves every tiddler, plugins included, and each goes to R2 and to the backup. With a public site, each is readable there by anyone the moment it's saved, and a public backup repository keeps it in its history after a delete. To publish part of a wiki only, export that part from the old wiki first (Advanced search → Filter, its export button) and import the export; or import the whole while the wiki is still private, delete what stays private, then add the public site ([operating 3.22](operating.md#322-making-a-private-wiki-public)). Don't upload your wiki as `index.html` instead: TiddlyWiki deletes, at the first sync, every tiddler the page came with that the server doesn't list, so the content would vanish from view, and the file itself would be public. Images kept as files beside the wiki (tiddlers with `_canonical_uri: images/…`) need that folder uploaded to the bucket under the same path (R2's *Upload*, or `npx wrangler r2 object put` with `--content-type`), and are then served like any file put in the bucket by hand ([operating 3.24](operating.md#324-images-and-files)): not backed up, not kept offline.

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

**Hearing of releases.** To be told of each release by e-mail: *Watch → Custom → Releases* on this repository (DesignThinkerer/tiddlywiki-cloudflare, not your fork), or follow its [releases feed](https://github.com/DesignThinkerer/tiddlywiki-cloudflare/releases.atom). Each release's notes open with what the update asks of you, or "Nothing", and the admin wiki's Cloudflare tab says when a newer release is out, once a day, when the tab is shown ([operating 3.1](operating.md#31-updating-your-copy)).

## 2.9 A second wiki

A second wiki is a second worker with its own bucket, queue, settings and, if public, its own public site: steps [2.2](#22-the-bucket-and-the-public-site) to [2.8](#28-the-first-visit) again with other names. From one repository, Wrangler environments do it: an `[env.notes]` section in `wrangler.toml` with that wiki's `name`, bucket and queue (and route, with a custom domain), deployed with `npx wrangler deploy --env notes` (as the deploy command of a second Workers Builds project, or from your computer); its settings go in that worker's dashboard like the first one's. The zone rules are per hostname, so each wiki gets its own set. One GitHub token per wiki, limited to its repository ([2.4](#24-the-backup-repository-optional)); the Cloudflare token (`CF_ZONE_ID`, `CF_API_TOKEN`) can be shared, named after the hostnames it purges, and when it's rolled or replaced, put the new value in each of those workers' `CF_API_TOKEN`, then run *Check the setup* in each: its purges line is the test. The free plan's limits ([limits 5](limits.md)) are per account, whichever way the wikis are deployed.

