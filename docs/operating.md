# 3. Operating it

*Chapter 3 of the [manual](../README.md#the-manual). Each section is about one thing you may do or meet while running the wiki.*

## 3.1 Updating your copy

Your worker is deployed from your copy of this repository, which this one keeps changing.

**Whether a newer release is out:** Control Panel → Saving → Cloudflare, *The worker*, shows the worker's version (the release's date, then a build hash) and, when the tab is shown, asks GitHub's releases API for this repository's newest release, from your browser, at most once a day: a newer one is announced with its date, linked to its notes, and the way to take it is this section; otherwise the line says this is the newest release, or newer than it (a copy synced past it), and when it was checked. Nothing is asked at page load, nothing goes through the worker, and no token is involved: the repository is public. When GitHub can't be asked (no network, its rate limit), the line says so and why, and the tab asks again the next time it's shown; the [releases page](https://github.com/DesignThinkerer/tiddlywiki-cloudflare/releases) has the answer meanwhile. [Design 1.17](design.md#117-the-release-check), [2.32](design.md#232-the-update-available-line-github-asked-from-the-browser-when-the-tab-is-shown-no-button-no-setting).

To take an update: on GitHub, *Sync fork* on your fork; Workers Builds redeploys, and the next admin page load rebuilds the page.

Nothing in the repository holds your values (`wrangler.toml` is deployed as it is, the settings live in the dashboard, [setup 2.5](setup.md#25-the-worker)), so an update never conflicts with them. [CHANGELOG.md](../CHANGELOG.md) lists, for each change, anything to do by hand — a new setting, a new zone rule; unless it says so, nothing is.

After an update, reload any open admin tabs: tabs opened before it keep the old modules, and tabs older than the modules have no conflict protection.

## 3.2 A full backup

Control Panel → Saving → Cloudflare, *Back up everything to GitHub*: run it whenever GitHub might not mirror the wiki — backups set up after content existed, a restore, a tiddler put in R2 by hand, a backup that failed for good and was fixed, backups the queue dropped (the day's operations used up during a big import, [limits 5](limits.md)).

It commits only what differs and removes files of tiddlers that are gone, so running it in doubt costs little: a step of about 20 tiddlers every few seconds, 3 queue operations a step, and GitHub calls only for what's missing ([design 1.7](design.md#17-github-backup)).

If the tab says the last one stopped without finishing, or didn't go through (the queue refused the job), start it again.

A tiddler too big to back up ([limits 5](limits.md)) doesn't stop it: cut short on it once, the full backup goes past it, counts it among the tiddlers not backed up, and the alert names it, saying so. Split the tiddler, or move the worker to a paid plan, then run the full backup again.

## 3.3 Updating the wiki engine

A new TiddlyWiki version comes with the repository: `package.json` pins the `tiddlywiki` package (bumped by hand, in a pull request of its own, not by Dependabot: a new engine is checked against the browser modules and the list filter first), and the worker ships the empty wiki built from it.

To move your wiki to it, update your copy (*Sync fork*, or the pull request that bumps the version, so the tests run on it), let Workers Builds deploy, then open the admin wiki: Control Panel → Saving → Cloudflare shows *Engine: TiddlyWiki 5.4.1 — the worker ships 5.4.2* and a button, *Update the engine*. It asks once more, in the tab, saying what goes with the old engine; then the worker replaces `index.html` with the one it ships, and the next page load builds the page from it, publishes the core file and the page for the new version and purges the public copy ([design 1.15](design.md#115-the-engine-update)). Your tiddlers, the plugins you installed and the published page aren't touched.

The swap can't be undone from the tab: the current `index.html` isn't kept anywhere (the bucket has no versioning, and the backup covers tiddlers only). If you uploaded it yourself, download it from R2 first (R2 → the bucket → Objects → `index.html`). What goes: a plugin that came with the current engine and wasn't installed from the wiki — one you baked into an `index.html` you uploaded yourself, say. A plugin that came with the engine and that you updated from the library keeps your version, which may now be older than the new engine's: to take the new engine's version, delete your copy after *Replace it* and before you reload (wait for the save). Deleted later, it's gone, and [3.4](#34-plugins)'s steps in R2 (delete `_page/shell.html` and `baked.html`, then open the admin wiki) bring the new engine's version back. A new TiddlyWiki can break a third-party plugin: if the wiki doesn't start after the reload, [3.6](#36-if-a-plugin-breaks-the-page). When the versions match, the tab says so and shows no button.

When the engine is newer than the one the worker ships (an `index.html` you uploaded, or a worker behind), the tab says so, "TiddlyWiki 5.5.0, newer than the 5.4.1 the worker ships", and the button reads *Go back to 5.4.1*: the usual way is to update your copy of the worker ([3.1](#31-updating-your-copy)) once it ships that version, going back only if the newer engine gives trouble (the page not published, [troubleshooting 4](troubleshooting.md)); its ask says that tiddlers saved by the newer version will run on the older one. The versions are compared in the tab, from what the page carries: no request.

Deleting `index.html` in R2 and opening the admin wiki does the same, and uploading an `index.html` of your own (an empty TiddlyWiki with the TiddlyWeb plugin) still works: the tab then shows its version.

Plugins installed through the wiki override the copies in `index.html`: after an upgrade, update the version in the plugin library's URL (`$:/config/OfficialPluginLibrary`) and update your plugins from its Updates tab.

## 3.4 Plugins

Install, update, disable or delete them from the wiki (drag and drop, the plugin library, the Control Panel). When TiddlyWiki asks you to reload, wait until the save has finished, then reload. The public site gets the same plugins.

As in a single-file wiki, updating a plugin that came with `index.html` (a theme from the plugin library, say) replaces it, and deleting it afterwards removes it. To get `index.html`'s version back: in R2, delete `_page/shell.html` and `baked.html`, then open the admin wiki. The page is built from `index.html` again, and that load publishes it. Any other plugin from `index.html` you deleted comes back too.

## 3.5 The published page

Nothing to do. After this version is deployed, the first admin page load publishes the core file and the page; after that, every save that changes the page publishes it ([design 1.9](design.md#19-the-page-published-from-the-admin-wiki)). Control Panel → Saving → Cloudflare → *The page* says what this tab last did with it and when: published, not published yet (still loading, during an import), or not published with the worker's reason; a refusal stays on the page as an alert until a publish goes through.

**If a tiddler of yours stops the wiki from starting** (one tagged `$:/tags/RawMarkup…`: a snippet pasted for analytics, fonts or a splash screen), on both sites, TiddlyWiki's red box on the admin site ends with a line that links the troubleshooting page; the way back:
1. In R2, delete `_page/shell.html` and `baked.html`.
2. Open the admin wiki: the page is built from `index.html` again.
3. Fix or delete the tiddler in that tab before reloading. The tab publishes the broken page again once loaded, but it keeps running the page it has, and saving the fix publishes the fixed one.

## 3.6 If a plugin breaks the page

When the wiki doesn't start after a plugin was installed, on both sites (TiddlyWiki's red box on the admin site ends with a line that links the troubleshooting page). A plugin with a raw markup tiddler, or a page that comes back and breaks again at the next rebuild: [3.7](#37-a-plugin-with-raw-markup) instead. Close every other admin tab first: a save there rebuilds the page and writes the file again. Then:
1. In R2, delete `_plugins/<plugin title>.js`. R2's dashboard lists a key by its slashes as folders: `_plugins/$:/plugins/x/y.js` sits under `_plugins`, then `$:`, then `plugins`, then `x`. From a computer, under your own login, `npx wrangler r2 object delete "<bucket>/_plugins/<plugin title>.js" --remote` does the same.
2. *(public site only)* Purge it from Cloudflare's cache: Caching → Configuration → Purge Cache → *Custom Purge* → *Hostname*, the public site's host (never *Purge Everything*, which clears every site in the zone, [design 2.10](design.md#210-targeted-purges-not-purge-everything)); or the exact URL with its `?v=`, readable with the browser's *View Source* even when the wiki doesn't start.
3. Hard-reload the admin wiki (Ctrl+Shift+R; on a Mac, Cmd+Shift+R, or Option+Cmd+R in Safari). It starts without the plugin. TiddlyWiki may ask for a reload; ignore it.
4. Delete or disable the plugin in the Control Panel and wait for the save. The page is rebuilt without it, or with it disabled.

On a phone, or in the installed app, there is no hard reload, and the service worker serves the plugin's file from the device's cache until step 4 rebuilds the page: do steps 3 and 4 in a private window, which starts with no service worker and no cached files (you log in to Access again), or from a computer; the other devices and the app pick up the fixed page at their next load, since it no longer loads that file. If the page is rebuilt before step 4 (by a deploy, or by saving another plugin, a startup action, `$:/theme` or a disable flag), the file is written again; delete it again.

## 3.7 A plugin with raw markup

A plugin with raw markup (one with a tiddler tagged `$:/tags/RawMarkup…`) is in the page as well as in its file ([design 1.9](design.md#19-the-page-published-from-the-admin-wiki)), so deleting the file isn't enough, and a page built again writes the file again while the plugin is stored. Remove the plugin itself, in R2:
1. Delete `recipes/default/tiddlers/<plugin title>` and `_plugins/<plugin title>.js`, then `recipes/default/tiddlers.json`, `_page/shell.html` and `baked.html`. Only the plugin's own object under `recipes/default/tiddlers/`: a tiddler deleted by mistake comes back from its file on GitHub, dropped onto the admin wiki once it starts ([setup 2.4](setup.md#24-the-backup-repository-optional)).
2. *(public site only)* Purge the public hostname from Cloudflare's cache ([3.9](#39-manual-purge)).
3. Open the admin wiki. The worker rebuilds the tiddler list from the stored tiddlers ([design 1.2](design.md#12-storage-revisions-and-etags)) and the page from `index.html`, both without the plugin, and the admin wiki then publishes its page. The wiki opens empty and fills in as the list is rebuilt, roughly a second per hundred tiddlers, a notification saying so after a second or two: no need to reload. The GitHub backup still has the plugin (`tiddlers/<plugin title>.json`), to install again once fixed.

## 3.8 Log lines

The worker's logs are under its Logs tab in the dashboard. What the lines mean:

| Line | Meaning |
|---|---|
| `[Backup] '<title>' not backed up yet (<reason>); retrying in Ns` | A GitHub call failed. It will be retried, and nothing is lost. |
| `[Backup] Could not queue '<title>', backing up directly` | The queue was unavailable, so the backup ran directly. |
| `[Backup] '<title>' could not be backed up` | A direct backup (no queue bound, or the queue unavailable) failed 3 times. That version isn't on GitHub, and nothing retries it: the admin wiki's alert says so after an hour. Save the tiddler again once the cause is fixed, or bind the queue ([setup 2.3](setup.md#23-the-backup-queue)) and run a full backup ([setup 2.4](setup.md#24-the-backup-repository-optional)). |
| `[Backup] Full backup: '<title>' (<n> bytes) was cut short at the delivery before: skipped` | A full backup's step, delivered again after the runtime cut it short on this tiddler (too big to back up, [limits 5](limits.md)), went past it: the tiddler counts among those not backed up, and the admin wiki's alert names it. Split it, or move the worker to a paid plan, then run the full backup again. |
| `Cache purge failed (<status>)` | The purge API refused; check the `CF_API_TOKEN` permission. |
| `[Tiddler list] Write conflict detected, retrying` | Two saves updated the tiddler list at once. This is normal and retried automatically; a save that loses five such races in a row is answered "The tiddler list couldn't be updated", and TiddlyWiki sends it again by itself. |
| `The tiddler list can't be read: rebuilding it from the stored tiddlers` | The list was damaged, and the worker is rebuilding it ([design 1.2](design.md#12-storage-revisions-and-etags)). The damaged copy is in `_repair/`. |
| `Tiddler list rebuilt: <n> tiddlers` | The rebuild is complete. |
| `Rebuilding the tiddler list: <key> is not a readable tiddler, left out` | That object in R2 isn't valid JSON. It was already unreadable for the wiki. |
| `Rebuilding the tiddler list: <key> isn't stored the way the worker stores tiddlers, left out` | An object in an older layout, under a URL-encoded key, or uploaded by hand ([design 1.2](design.md#12-storage-revisions-and-etags)). Save the tiddler again from a wiki that has it, or upload it in the flat layout with its metadata ([design 1.2](design.md#12-storage-revisions-and-etags)); an object under a URL-encoded key can be deleted. |
| `Failed to rebake HTML` | Building `baked.html` failed; the last page built is served instead (or `index.html` if there is none). A list being rebuilt over several requests also shows this line until it's done. |

## 3.9 Manual purge

Cloudflare dashboard → Caching → Configuration → Purge Cache → *Custom Purge* → *Hostname*, the public hostname. Use it if something on the public site looks stuck, for example after uploading files to R2 by hand, and once after a purge token was replaced or fixed: what changed while purges failed stays cached until its Edge TTL otherwise, a day with the guide's setting, and the admin wiki says so meanwhile (an alert, once a few of its reads from the public site come back stale: [design 2.20](design.md#220-the-setup-check-from-the-worker-on-demand-one-purge-as-the-tokens-test)).

## 3.10 Loading a big wiki

A tab gets the tiddler list (every field but the text) and loads the tiddler it shows first; the rest fills in in the background, several at a time, only while the tab is visible, so that search and backlinks work on everything.

Loaded tiddlers are kept in the browser (IndexedDB, like its cache: clearing the site's data removes them), so the next page load fetches only what changed since, on any device.

To skip the fill, untick it in the plugin's settings (below; it takes effect at the next page load): each tiddler then loads the moment it's shown, and nothing else is fetched, but the sidebar's text search, backlinks and the Missing and Orphans lists only see tiddlers the tab has loaded (titles, tags and fields are always searched). [Design 1.5](design.md#15-keeping-worker-requests-down).

## 3.11 Editing offline

With the admin wiki open, keep editing without a network. TiddlyWiki retries every few seconds; the moment the connection is back, everything reaches the worker, each save checked for conflicts as usual. Its *Network Error* alert isn't shown on the admin wiki (it would be back at every retry): the cloud icon turning red and its dropdown say it, below. TiddlyWiki's other alerts — a save the worker refuses, say — show as always.

What this setup adds is that nothing is lost in between: every change is written to this device at once (the same store that keeps your tiddlers for reading), so a reload, a crash or a closed tab while offline keeps it, and the next time the wiki opens on this device it sends it — a tiddler changed elsewhere meanwhile gets a conflict copy, as online.

If the browser refuses to store a change — no room left, or storage unavailable in that window — the dropdown says so instead of promising: the change then lives only in that tab until it's sent, so keep the tab open. A draft is kept there too, never sent to the worker: after a reload, TiddlyWiki lists it at the top of the page, with the text as you left it. The browser still asks before you leave while an editor holds changes: the device takes the draft a moment behind your typing, so the very last of it may not be there yet, and it can refuse the write. (The other tabs of the same browser follow this one — what you save, the draft you're typing: "Tabs following each other", below.)

The cloud icon in the sidebar turns red while something is unsaved, as it always has; click it for how many changes are waiting, since when, and whether you're offline or your login has expired (below); with nothing waiting and no network, its dropdown still says you're offline, in one line. What waits on a device is sent from that device: another device doesn't see it until then. Opening the wiki *with no network at all* still needs the page from a server. [Design 1.10](design.md#110-editing-offline-the-outbox).

## 3.12 Tabs following each other

The admin wiki's tabs in one browser share your work, without the worker. A tiddler changed, created or deleted in one tab shows so in the others at once, online or offline, not at their next poll, and they make no request for it: they take the change from the tab that made it, and the worker's revision once the save is confirmed.

A tiddler you're editing is one draft for the browser: while you type in one tab, the draft is listed at the top of the others, and any tab that opens it, from that list or with *Edit*, shows the same text and follows your typing as you go (a moment behind, at TiddlyWiki's own pace for drafts); type in that tab instead and the first follows, in the editor you had typed in too. Save or cancel in any tab and it's saved or cancelled in all of them, once. A reload of any tab brings the draft back.

Across devices nothing changes: another device sees a save at its next poll and never sees your drafts; a change you hadn't saved when another tab saved the same tiddler still gets a conflict copy, as today. [Design 1.16](design.md#116-tabs-following-each-other), 2.27.

## 3.13 Opening the wiki offline

After one visit online, the admin wiki opens without a network. A service worker the admin site registers keeps the page, TiddlyWiki's core file, the plugin files, the status file and the last tiddler list; the tiddlers come from the device copy. It fills its cache as soon as it's installed, at that first visit, after the page has loaded (two requests to the worker, once per device), so *Check the setup* run on that first load says the core file isn't kept yet and asks for one reload, and every line is fine from the second, and at every page load online it keeps the files the page refers to, so a file missing from the cache — a browser clearing space, a copy that didn't finish — is back at the next load online.

Online, nothing changes: the page is always asked from the worker first, so an update's new page, or Cloudflare Access asking you to log in again, shows as before — the cache only answers when the network doesn't.

Offline, only what this device has loaded is there: a tiddler never opened on it stays empty. Type into one and save, and your text isn't lost and doesn't replace the stored one: once the network is back, the worker refuses that save, your text is kept beside the tiddler as a conflict copy, the tiddler shows its stored text, and an alert says so (3.20). The tiddler list is the last one this device kept, which can be older than its last saves, so a list from the cache can only add: the wiki completes it with what the device holds and removes nothing while offline — not from the tab, not from the device copy, not from the outbox; what was deleted elsewhere meanwhile goes at the network's return, when a real list comes. A change made then waits in the outbox like any other. If your Access session expires while you're offline, the dropdown says offline until the network is back, then that the login has expired (below).

For a public wiki, the core and plugin files are kept for offline use only with the CORS rule ([setup 2.7](setup.md#27-the-zones-rules-public-site-only)) in place, its `/_plugins/` path included; without it they load as before, online only, and with no network and no copy of the core file on the device the page says so in a line.

The admin wiki asks the browser to keep this site's storage (the service worker's cache, the device copy, the outbox) rather than clear it when short of space; browsers grant that by their own rules (Chrome to a site used often, installed or bookmarked; Firefox asks you), and the cloud icon's dropdown says when it isn't granted and a change waits. [Design 1.11](design.md#111-opening-the-wiki-offline-the-service-worker).

## 3.14 When your login expires

Cloudflare Access ends a session after a set time (a day by default: the application's *Session duration*, [setup 2.6](setup.md#26-cloudflare-access)), and a tab left open past it can't reach the worker any more. A save, and on a private wiki a tiddler load, gets Access's login page in place of an answer, while the tiddler list goes on from the copy the service worker keeps, so nothing looks wrong until you edit.

The tab tells this from a lost network by asking Access itself (one request, answered at Cloudflare's edge, never a worker request, and only after something has failed or a list came from the cache), and the cloud icon's dropdown then says the login has expired, not "offline", whether or not a change waits: *Log in again* opens the login in a new tab, after which this tab sends what's waiting by itself; or reload this page, which shows the login and comes back with the kept changes sent.

Nothing is lost in between: every change is kept on this device, as when offline (above). *Check the setup* and the tab's two buttons, *Back up everything to GitHub* and *Update the engine*, say the same when their request gets no answer: the login expired, with this section as a link, or that you're offline, or that the worker can't be reached. [Design 1.10](design.md#110-editing-offline-the-outbox), 2.26.

## 3.15 Checking the setup

Control Panel → Saving → Cloudflare → *Check the setup* asks the worker to look at each piece and lists what it found, one line each, starting with its mark, ✓ fine, ✗ missing or wrong, – nothing to check or optional, which a screen reader says as a word, a missing or wrong one saying what was found, then, on its own line, *To do:* the one thing to do — where in the dashboard, which setting, which rule, in the setup guide's words with your addresses filled in — and naming the section of the setup guide with the full steps, as a link.

The pieces: Access protecting the admin site; the public site answering at `PUBLIC_WIKI_URL` with the page (the rewrite rule; an earlier build of the page, Cloudflare's cached copy, passes and is named; a 530 from Cloudflare's edge in the minutes after the domain is connected is named as such, to check again; a domain on another bucket than the worker's is told from a missing rule by the status file), allowing the admin site to read tiddlers from it and to keep the core and plugin files for offline use (the CORS rule, each of its two paths checked; a header with a wrong value is named with the value to set), and cached (the cache rules, optional: reported, never a failure); backups, optional: off, a dash with the two settings to make; set up, GitHub accepting the token for the repository and its branch; and the backup queue bound; purges allowed, tested by purging the public site's `status` file (optional without the cache rules; with them, what makes a change show on the public site at once, and the line says what the missing settings cost: the page kept for the rule's Edge TTL, a day with the guide's setting); and, in this browser, under *Opening offline*, the service worker in place and the core file kept, so the wiki opens offline. The backups line says what the check can't test, writing: save any tiddler, and if GitHub refuses it, the tab's Backups section and an alert say so. The result's footer, like the device measure's and the release line's, says the day and the time, since the tab keeps them for the session. A private wiki gets one line for the public site's pieces: no public site, so no rewrite, CORS or cache rules and no purges to check; it adds that a custom domain or the development URL left on the bucket serves the wiki all the same, which the worker can't see ([3.23](#323-making-a-public-wiki-private-or-changing-its-domain)). When the public site doesn't answer, its line says what to do, and the four lines about its rules say they weren't checked, each by name.

It runs only when you click — one request to the worker, which makes a few of its own to the public site, GitHub and Cloudflare — so it costs nothing at page load. Nothing says these things otherwise: the page's own requests work without the CORS header, and a missing rewrite rule shows only to visitors.

If the check itself gets no answer, the tab says which it is: no network, or your login has expired (it asks Access, as the dropdown does: "When your login expires", above). [Design 1.13](design.md#113-the-setup-check).

## 3.16 Installing the wiki as an app

The admin wiki is a web app the browser can install — Chrome shows an install button in the address bar, Android offers "Add to Home screen", on iOS use Safari's share menu — and it then opens in its own window, without the browser's bars, under its own icon and the wiki's title. Installed, Chrome also keeps the site's storage persistent (the device copy, the outbox, the service worker's cache) without being asked.

The icon is a plain one; to use your own, upload `_app/icon-192.png` and `_app/icon-512.png` to the bucket, square PNGs of those sizes (the worker puts the defaults there at the first page build, so you'll find them). Nothing to set up: the page carries the app's manifest, which the worker serves, with the wiki's title as the app's name.

The public site can be installed too, as a read-only app; it has no service worker, so it needs the network to open. [Design 1.12](design.md#112-the-wiki-as-an-installable-app).

## 3.17 The plugin and its settings

The admin wiki's modules travel as a plugin, `$:/plugins/cfworker/admin`, listed in Control Panel → Plugins with the worker's version, the release's date (`2026.10.20`: [the changelog](../CHANGELOG.md) has the block of that date) followed by a build hash: the worker puts it in every page it builds, so it always matches the worker, and never stores it. Its parts are shadow tiddlers, out of search and out of syncing; a part you edit is an override, as with any plugin — it stays through the worker's updates, the dialog marks it, delete it to get the worker's part back.

The plugin's *settings* tab holds the wiki's own settings (tiddlers under `$:/config/cfworker/`, saved like any other, so they hold on every device): the fill of the device copy (above) and TiddlyWiki's polling interval with its cost in worker requests — both read once, when a tab starts, so a change applies to tabs opened after it, as the tab says. Under a warning, the advanced ones:

- the pause before a draft is written to the device (300 ms; lower is more writes, higher is more typing lost if the tab crashes);
- how many tiddlers the fill fetches at once (6; more is a faster fill with more requests in flight — on a private wiki they're worker requests either way, the same number);
- the pause after a save before the page is published (1 s; a burst of saves is published once);
- how often the worker is asked how backups go (60 minutes, a minute at least, with a list request; one R2 read each, and the alert when backups fail comes that much later);
- how long the service worker waits for the network before answering with the page it kept (8 s; longer suits a slow connection, shorter a dead one; the page tells the service worker at each load, so that one applies at the next).

The defaults fit the free plan and are what the tests run; an empty field is the default. The worker's own settings stay in the dashboard ([setup 2.5](setup.md#25-the-worker)). [Design 2.21](design.md#221-the-modules-as-a-plugin-the-settings-in-its-tab-the-advanced-ones-under-a-warning).

## 3.18 This device

The plugin's *device* tab (Control Panel → Plugins → TiddlyWiki on Cloudflare) is about what this browser keeps of the wiki. *Measure* counts the tiddlers kept on this device of those the worker lists, with their size (the few the page itself carries — the site title, the default tiddlers, the settings — and any not loaded yet are counted apart); the changes and drafts waiting in the outbox; the files the service worker keeps, each with its size; then what the browser says — how much this site uses of what it allows (the browser's own count, more than the files' bytes) and whether it has promised to keep it.

*Ask the browser to keep this site's data* asks for that promise: Firefox asks you; Chrome and Safari decide by their own rules — a site used often, installed or bookmarked — and answer at once (ask again later, or install the wiki as an app). Without it, a browser short of space may clear the site's storage, a change waiting in the outbox with it, which is why the cloud icon's dropdown says so while something waits, with a link to the tab; the page no longer asks at every load (in Firefox that was a prompt at every load).

*Forget this device's copy* removes the device copy, the outbox and the service worker's files from this browser and reloads: the wiki comes back from the worker and the copy fills again, as on a new device; it's refused while a change or a draft waits, on the device or only in this tab, naming how many, and while the worker doesn't answer (the page comes back from the worker once the copy is gone). Nothing in the tab asks the worker anything. It isn't a way to leave nothing on a computer that isn't yours: *Forget* reloads, and the reload fills the copy again, while *Logout* ends the Access session alone and leaves the copy ([setup 2.6](setup.md#26-cloudflare-access) says what to do instead, [limits 5](limits.md)). [Design 1.14](design.md#114-the-device-tab), 2.22.

## 3.19 The browser modules: off, and checking they're on

To turn them off, set `CONFLICT_GUARD` to `off`. The next page load rebuilds `baked.html` without them. Saves then go back to TiddlyWiki's default behaviour, without protection or request savings, and the page is no longer published.

To check they're on: in the admin wiki's browser console, `$tw.syncadaptor.conflictGuardInstalled` should be `true` (the conflict guard), and `$tw.syncadaptor.cfworkerBackupAlert` too (the backup alert, which runs after the list sync).

## 3.20 When two tabs edit the same tiddler

Two tabs, two devices, or a script and a tab can't silently overwrite each other: every save says which version it's based on, and the worker refuses one based on a version that's no longer current ([design 1.4](design.md#14-edit-conflict-protection)). An alert says what happened, headed "Edit conflict", "Delete conflict" or "Deleted elsewhere", names the tiddler and the copy, and ends with what to do and this section as a link. What you see:

- **An edit conflict.** You save a tiddler that another tab or device saved after you started editing it (even if this tab loaded that version behind your open editor meanwhile). The tiddler then shows the version the worker has, your text is kept beside it as `<title> (conflict YYYY-MM-DD hh.mm.ss)`, opened in the story river, and an alert links both. Compare them, put what you want into the original, and delete the copy. Nothing is merged for you ([limits 5](limits.md#5-known-limits)), and nothing is overwritten.
- **A delete conflict.** You delete, or rename, a tiddler that another tab or device saved meanwhile: it isn't deleted, the newer version is restored in your tab, and an alert says so. A rename saves the new title first, then deletes the old one, so the new title keeps your text.
- **The same change from both sides** isn't a conflict: two tabs that save exactly the same content get no copy and no alert; the second simply takes the first's.
- **A tiddler deleted elsewhere** while you were editing it: your text is kept as a copy, and the original goes. Rename the copy if you want it back under its name.
- **A tiddler whose text hadn't loaded on this device.** Offline, or before the fill reached it ([3.10](#310-loading-a-big-wiki)), a tiddler never loaded here opens empty, with TiddlyWiki's loading bar. Type into it and save, and the worker refuses the save rather than let your text replace, on every device, a text this one never showed: your version is kept as a copy, as above, the tiddler shows its stored text, and the alert says the text hadn't loaded here. A tiddler that had no text takes your text as any save does.
- **A copy of code is inert.** The copy of a stylesheet, a macro, a startup action, a JavaScript module or a plugin would otherwise take effect as a second one (a plugin copy's contents would even override the original's). So a copy loses its system tags (every tag starting with `$:/`), kept in its `conflict-removed-tags` field, and its `module-type` or `plugin-type`, kept in `conflict-removed-module-type` or `conflict-removed-plugin-type`; the alert says so. To use that version, copy its text into the original, or, if the original was deleted elsewhere, rename the copy to that title and give it back those fields.

Every copy has a `conflict-of` field naming the original: the filter `[has[conflict-of]]`, in Advanced Search → Filter, lists them all. The tabs of one browser don't conflict with each other, since they share one draft (3.12, above); another browser or device never sees a draft, only what you save.

## 3.21 Removing the wiki

Everything the setup made is deleted by hand, in the dashboard, or with Wrangler under your own login for the three pieces it knows. The admin wiki has no button for it, on purpose: a worker able to delete its own bucket, and the backup, would hold a token that anything running in the wiki's page could use ([design 2.31](design.md#231-removing-a-wiki-the-dashboard-not-the-plugin)). Nothing below can be undone, and the backup repository is the one piece a wiki can be rebuilt from ([setup 2.4](setup.md#24-the-backup-repository-optional)): keep it until you're sure, or for good — a private repository costs nothing, and neither does an unused wiki on the free plan, so there's no hurry. In this order:

1. **In each browser you used,** while the worker still answers: *Forget this device's copy* in the plugin's device tab ([3.18](#318-this-device)), and uninstall the app if you installed it ([3.16](#316-installing-the-wiki-as-an-app)). Done afterwards, clearing the site's data in the browser does the same.
2. **If you keep the backup,** run a full backup ([3.2](#32-a-full-backup)) and let it finish: a message still in the queue is a save GitHub doesn't have yet.
3. **The worker** (Workers & Pages → the worker → Settings → *Delete*): its address, settings, secrets and builds go with it, and the admin site stops answering. From a clone of your copy, `npx wrangler delete` deletes the worker alone, not the bucket or the queue.
4. **The queue** (Storage & Databases → Queues → the queue → Settings → *Delete*), or `npx wrangler queues delete wiki-backup` with your queue's name ([setup 2.1](setup.md#21-before-you-start)).
5. **The bucket** (R2 → the bucket → Settings). With a public site, first *Remove domain* under Custom Domains, which removes its DNS record too (Cloudflare's guide advises it, so no record is left pointing at nothing). Then *Empty Bucket*, which empties it whatever its size, and *Delete Bucket*: a bucket is deleted empty — `npx wrangler r2 bucket delete wiki` refuses one with objects in it, and Wrangler deletes objects one at a time, so this step is the dashboard's.
6. *(public site only)* **The zone's rules** of [setup 2.7](setup.md#27-the-zones-rules-public-site-only), under your domain's Rules: the rewrite rule, the response header rule and the cache rules. They name the hostname, so they do nothing once it's gone, but they count against the zone's free rules. `CF_ZONE_ID` is nothing to delete.
7. **The Access application** (Zero Trust → Access → Applications), and its policy if it was made for it alone.
8. **The tokens:** the Cloudflare API token (My Profile → API Tokens) and the GitHub token (Settings → Developer settings → Personal access tokens → Fine-grained tokens). Useless without the worker, valid until they expire.
9. **On GitHub:** your fork of this repository, Settings → *Danger Zone* → *Delete this repository*; and Cloudflare's GitHub app, if you installed it for this alone (Settings → Applications → Installed GitHub Apps). The backup repository last, or kept.

A private wiki skips the domain, the rules and the Cloudflare token. A second wiki ([setup 2.9](setup.md#29-a-second-wiki)) has its own worker, bucket, queue, application and rules, but the tokens and the zone can be shared: check before deleting those.

## 3.22 Making a private wiki public

A private wiki gets its public site the way a new one does: the steps of the setup guide marked *(public site only)*, the bucket's custom domain, the zone's rules for that hostname and the worker's three settings, in the order below. Nothing moves: the bucket's layout is the same for both, the first visit wrote the public site's `status` file, and the same worker runs both ([design 2.15](design.md#215-a-private-wiki-is-the-same-worker-without-a-public-address)). But the domain makes everything in the bucket readable by anyone from the moment it's connected, every tiddler written while the wiki was private included, so the first step comes before it.

1. **What shouldn't be public leaves the bucket.** A public wiki can't hold private tiddlers: delete them, or move them to a second wiki that stays private ([setup 2.9](setup.md#29-a-second-wiki)), exported from this one first (Advanced search → Filter, its export button), imported there, then deleted here. The backup repository keeps every version of them in its history ([setup 2.4](setup.md#24-the-backup-repository-optional)): keep it private, or give the public wiki a new one.
2. **The domain** ([setup 2.2](setup.md#22-the-bucket-and-the-public-site), step 2): connect it under the bucket's Custom Domains, leave the development URL (`r2.dev`) disabled, wait for *Active*, and open `https://wiki.example.com/status` until R2 answers with the status file's JSON. The bucket is public from here.
3. **The zone's rules** ([setup 2.7](setup.md#27-the-zones-rules-public-site-only)), before the address: the rewrite rule, the cache rules and the CORS rule. With the CORS rule in place first, the first load after the address keeps the core file on each device for offline use, as before; without it the page works online, and the file is kept at a later load, once the rule is there.
4. **The settings** ([setup 2.5](setup.md#25-the-worker)): `PUBLIC_WIKI_URL`, with `CF_ZONE_ID` and `CF_API_TOKEN` at the same time, so that the page the next load publishes is purged, rather than what Cloudflare cached of the site meanwhile (your own look at it included) kept for the cache rule's Edge TTL. Saving a variable deploys it at once; set before the domain answers, the admin wiki can't publish its page and says so until the site does ([2.2](setup.md#22-the-bucket-and-the-public-site)).
5. **Open the admin wiki twice.** The first load builds the page from the engine, since the page published for the private wiki loads the core file from the worker, and the admin wiki publishes the page for the new address, with the core file on the public site ([design 1.9](design.md#19-the-page-published-from-the-admin-wiki)); on the second load, *Check the setup* ([3.15](#315-checking-the-setup)) should show every line fine. Open the public site to see it. Each device's next load reads tiddlers from the public site, as a public wiki's does, and keeps its copy.

## 3.23 Making a public wiki private, or changing its domain

What makes the wiki public is the domain connected to the bucket, not the worker's setting. `PUBLIC_WIKI_URL` removed, the next page load builds the page for a private wiki and the admin wiki publishes it, the worker serving the core and plugin files itself, but the bucket's custom domain goes on serving everything in it, every new save included, and nothing is purged any more; the development URL, if it was ever turned on, the same. The worker can't see the bucket's domains, so *Check the setup* says there's nothing to check, and reminds you of this. To make the wiki private:

1. **Remove the domain from the bucket** (R2 → the bucket → Settings → Custom Domains → *Remove domain*): that's what makes it private, and it removes the DNS record with it ([3.21](#321-removing-the-wiki)). Make sure the **Public Development URL (`r2.dev`)** is disabled. Until the next step, the admin wiki's page still loads the core file and reads tiddlers from the address that's gone: slow at best, and no start on a device with no copy of the core file kept ([troubleshooting 4](troubleshooting.md)), so do the next step right after.
2. **Remove `PUBLIC_WIKI_URL`,** and `CF_ZONE_ID` and `CF_API_TOKEN` with it ([setup 2.5](setup.md#25-the-worker)). The next load of the admin wiki builds the page from the engine and publishes it for the private wiki; each device's first load after that reads every tiddler from the worker, once ([limits 5](limits.md)).
3. **The hostname's rules** ([setup 2.7](setup.md#27-the-zones-rules-public-site-only)): delete them. They name the hostname, so they do nothing once it's gone, but they count against the zone's free rules. Purge the hostname once ([3.9](#39-manual-purge)), so that nothing of the wiki is left in Cloudflare's cache for it.
4. **The backup repository,** if it's public: make it private (on GitHub, the repository's Settings → Danger Zone → *Change visibility*), as a private wiki's has to be ([setup 2.4](setup.md#24-the-backup-repository-optional)); *Check the setup* fails the backups line until then.

**Changing the domain** is the two put together, the new domain first, so that the admin wiki runs throughout: connect it and wait until it answers ([setup 2.2](setup.md#22-the-bucket-and-the-public-site)), its rules ([2.7](setup.md#27-the-zones-rules-public-site-only)), then `PUBLIC_WIKI_URL` set to it, and the admin wiki opened twice, which publishes the page for the new address ([3.22](#322-making-a-private-wiki-public), step 5); then the old domain removed from the bucket, its rules deleted and the old hostname purged once. The admin site's own address is another matter: it's in the CORS rule's value and in Access, and changes nothing of the bucket.
