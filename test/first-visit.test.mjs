// End-to-end test of a new wiki: an empty bucket, the empty wiki the build made uploaded with the
// worker, a real TiddlyWiki in Chromium. The first admin page load puts the engine and the
// public status file in the bucket; the wiki boots, saves, and the public site serves it.
// Run: npm run test:first
import { createChecks, createWatcher, finish, launchBrowser, settle, startSite, waitFor } from "./browser-harness.mjs";

const site = await startSite();   // no index: the bucket starts empty
const { base, pub: PUB, bucket } = site;
const { check, results } = createChecks();
const browser = await launchBrowser();
const context = await browser.newContext();
const { requests, pageErrors, watch } = createWatcher(site);

check("the bucket starts empty", !(await bucket.head("index.html")) && !(await bucket.head("status")) && !(await bucket.head("baked.html")));

// 1. The first admin visit
const admin = await context.newPage();
await watch(admin, "admin");
admin.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`admin console: ${m.text()}`); });
const first = await admin.goto(base + "/");
await admin.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
await settle(admin);
check("the first admin visit serves a page that boots TiddlyWiki, with the browser module", first.status() === 200 && await admin.evaluate(() => $tw.syncadaptor.conflictGuardInstalled === true));
check("...the engine and the public status file are now in the bucket, and the page built", !!(await bucket.head("index.html")) && !!(await bucket.head("status")) && !!(await bucket.head("baked.html")));
const published = await waitFor(async () => !!(await bucket.head("_page/shell.html")) && !!(await bucket.head("_plugins/tiddlywikicore.js")), 30000);
check("...and that load publishes the core file and the page for the public site (setup 2.8)", published);
check("...TiddlyWiki loaded the browser modules: the library, and the nine startup modules, the backup alert after the list sync",
  await admin.evaluate(() => {
    const startup = $tw.modules.types.startup || {}, library = $tw.modules.types.library || {};
    const names = ["$:/cfworker/conflict-guard.js", "$:/cfworker/list-sync.js", "$:/cfworker/backup-alert.js", "$:/cfworker/page-publisher.js", "$:/cfworker/restore-import.js", "$:/cfworker/control-panel.js", "$:/cfworker/outbox.js", "$:/cfworker/cold-start.js", "$:/cfworker/device.js"];
    const alert = startup["$:/cfworker/backup-alert.js"];
    return !!library["$:/cfworker/lib.js"] && names.every(n => startup[n]) && alert.exports.after.includes("cfworker-list-sync");
  }));
check("...as the shadows of the admin plugin, which the Plugins tab lists with its name and version; none of them a tiddler of the wiki",
  await admin.evaluate(() => {
    const info = $tw.wiki.getPluginInfo("$:/plugins/cfworker/admin");
    const parts = ["$:/cfworker/lib.js", "$:/cfworker/conflict-guard.js", "$:/cfworker/list-sync.js", "$:/cfworker/backup-alert.js", "$:/cfworker/page-publisher.js", "$:/cfworker/restore-import.js", "$:/cfworker/control-panel.js", "$:/cfworker/outbox.js", "$:/cfworker/cold-start.js", "$:/cfworker/device.js", "$:/cfworker/public-url", "$:/cfworker/sw-url", "$:/cfworker/page-source", "$:/plugins/cfworker/admin/readme", "$:/plugins/cfworker/admin/settings", "$:/plugins/cfworker/admin/device"];
    const listed = $tw.wiki.filterTiddlers("[plugin-type[plugin]]").includes("$:/plugins/cfworker/admin");
    const plugin = $tw.wiki.getTiddler("$:/plugins/cfworker/admin");
    return !!info && listed && !!plugin && !!plugin.fields.name && /\+/.test(plugin.fields.version || "") && parts.every(t => $tw.wiki.isShadowTiddler(t) && !$tw.wiki.tiddlerExists(t)) &&
      $tw.wiki.getTiddlerText("$:/plugins/cfworker/admin/readme", "").length > 100 && $tw.wiki.getTiddlerText("$:/plugins/cfworker/admin/settings", "").includes("$:/config/cfworker/LoadAll");
  }), await admin.evaluate(() => JSON.stringify({ info: !!$tw.wiki.getPluginInfo("$:/plugins/cfworker/admin"), shadow: $tw.wiki.isShadowTiddler("$:/cfworker/lib.js"), real: $tw.wiki.tiddlerExists("$:/cfworker/lib.js") })));
check("...and each part of the sync is in place: the conflict guard, the list (with its listeners), the alert's request",
  await admin.evaluate(() => $tw.syncadaptor.conflictGuardInstalled === true && typeof $tw.syncadaptor.cfworkerListed === "function" && typeof $tw.syncadaptor.cfworkerOnList === "function" && $tw.syncadaptor.cfworkerBackupAlert === true));
check("...the tab is logged in and can write", await admin.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsLoggedIn") === "yes" && $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "no"));
check("...the wiki is empty: nothing to load", (await admin.evaluate(() => $tw.wiki.filterTiddlers("[all[tiddlers]!is[system]]").length)) === 0);

// 2. A save
await admin.evaluate(() => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), { title: "First note", text: "Hello from a new wiki" }, $tw.wiki.getModificationFields())));
await settle(admin);
const stored = await bucket.get("recipes/default/tiddlers/First note");
const storedFields = stored ? await stored.json() : null;
check("a tiddler saved from the new wiki is stored and listed", storedFields?.text === "Hello from a new wiki" && (await (await bucket.get("recipes/default/tiddlers.json")).json()).some(t => t.title === "First note"));

// 3. The public site: the page, read-only, with the tiddler (through the stand-in that serves the bucket)
const visitor = await context.newPage();
await watch(visitor, "visitor");
visitor.on("console", m => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) pageErrors.push(`visitor console: ${m.text()}`); });
const publicPage = await visitor.goto(PUB + "/");
await visitor.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
check("the public site serves the page", publicPage.status() === 200);
const seen = await waitFor(() => visitor.evaluate(() => $tw.wiki.getTiddlerText("First note") === "Hello from a new wiki"));
check("...a visitor sees the tiddler, read-only, through the status file the first visit wrote", seen && await visitor.evaluate(() => $tw.wiki.getTiddlerText("$:/status/IsReadOnly") === "yes" && $tw.wiki.getTiddlerText("$:/status/IsLoggedIn") === "no"));
check("...and the visitor never used the worker", !requests.some(r => r.tag === "visitor" && r.origin === "worker"), requests.filter(r => r.tag === "visitor" && r.origin === "worker").map(r => r.path).join(", "));

// 4. The test pages open with their waits shortened (browser-harness.mjs, design 2.25); a page of a
// context without that has the waits a deployed wiki has
const waits = p => p.evaluate(() => ({
  throttle: $tw.syncer.throttleInterval, errorRetry: $tw.syncer.errorRetryInterval,
  scale: $tw.modules.execute("$:/cfworker/lib.js").timeScale(), wait: $tw.modules.execute("$:/cfworker/lib.js").wait(1000)
})).catch(e => ({ error: e.message }));
const fastWaits = await waits(admin);
check("the test pages shorten the waits: TiddlyWiki's throttle 50 ms and its error retry 1 s, the modules' waits scaled to a fifth",
  fastWaits.throttle === 50 && fastWaits.errorRetry === 1000 && fastWaits.scale === 0.2 && fastWaits.wait === 200, JSON.stringify(fastWaits));
const slow = await (await browser.newContext({ fast: false })).newPage();
await slow.goto(base + "/");
await slow.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
const slowWaits = await waits(slow);
check("...a page without that has the waits a deployed wiki has: TiddlyWiki's 1 s and 5 s, the modules' as they are",
  slowWaits.throttle === 1000 && slowWaits.errorRetry === 5000 && slowWaits.scale === 1 && slowWaits.wait === 1000, JSON.stringify(slowWaits));
// A stored tiddler can't set the scale: only the harness's script, before the page boots
await fetch(`${base}/recipes/default/tiddlers/${encodeURIComponent("$:/config/cfworker/TestTimeScale")}`,
  { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "$:/config/cfworker/TestTimeScale", text: "0.5" }) });
await slow.reload();
await slow.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
const storedScale = await waits(slow);
check("...and a tiddler of that name stored in the wiki changes nothing: the scale is the test harness's, not a setting",
  await slow.evaluate(() => $tw.wiki.getTiddlerText("$:/config/cfworker/TestTimeScale") === "0.5") && storedScale.scale === 1 && storedScale.wait === 1000, JSON.stringify(storedScale));

// 5. Logout, in the cloud icon's dropdown: the session is Cloudflare Access's, ended at its own
// address (setup 2.6), not at a /logout route the worker doesn't have
const loggedOut = admin.waitForURL("**/cdn-cgi/access/logout", { timeout: 10000 }).then(() => true, () => false);
await admin.evaluate(() => $tw.rootWidget.dispatchEvent({ type: "tm-logout" }));
check("Logout (the cloud icon's dropdown) goes to Cloudflare Access's logout page, which ends the session; nothing posted to a /logout of the worker",
  await loggedOut && !requests.some(r => r.tag === "admin" && r.path === "/logout"), `at ${admin.url()}; /logout requests: ${requests.filter(r => r.tag === "admin" && r.path === "/logout").map(r => `${r.method} ${r.status}`).join(", ")}`);

await finish({ check, results, pageErrors, browser, site });
