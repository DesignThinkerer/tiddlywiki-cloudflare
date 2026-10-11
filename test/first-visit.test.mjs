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
check("...and that load publishes the core file and the page for the public site (README 2.8)", published);
check("...TiddlyWiki loaded the browser modules: the library, and the six startup modules, the backup alert after the list sync",
  await admin.evaluate(() => {
    const startup = $tw.modules.types.startup || {}, library = $tw.modules.types.library || {};
    const names = ["$:/cfworker/conflict-guard.js", "$:/cfworker/list-sync.js", "$:/cfworker/backup-alert.js", "$:/cfworker/page-publisher.js", "$:/cfworker/restore-import.js", "$:/cfworker/control-panel.js"];
    const alert = startup["$:/cfworker/backup-alert.js"];
    return !!library["$:/cfworker/lib.js"] && names.every(n => startup[n]) && alert.exports.after.includes("cfworker-list-sync");
  }));
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

await finish({ check, results, pageErrors, browser, site });
