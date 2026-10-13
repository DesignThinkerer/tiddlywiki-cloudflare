// Takes the README's screenshot, docs/admin-wiki.png: the admin wiki with the Control Panel open on
// Saving → Cloudflare after "Check the setup", every line fine. A public wiki with backups, from the
// test setup (test/browser-harness.mjs: the worker in Miniflare, the stand-in for the public site,
// GitHub and Cloudflare's API imitated), so the addresses in the picture are local ones. Run it
// when the tab changes: npm run screenshot (after npm run build; CHROMIUM_PATH as for the tests).
// The picture is written only when every line of the check is fine: otherwise it says which aren't,
// leaves the picture as it is, and exits 1.
import { fileURLToPath } from "node:url";
import { launchBrowser, readWikiFile, settle, startSite, waitFor } from "../test/browser-harness.mjs";

const OUT = fileURLToPath(new URL("../docs/admin-wiki.png", import.meta.url));
const VIEWPORT = { width: 1280, height: 884 };   // the tab down to its "Checked at" line
const SCALE = 1.5;                                // crisp when the README shows it smaller

// GitHub and Cloudflare's API as the setup check asks them: the repository and its branch there,
// the purge accepted (what test/setup-check.test.mjs answers for "everything in place")
function outbound(request) {
  const url = new URL(request.url);
  if (url.hostname === "api.github.com") {
    const branch = url.pathname.match(/\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/);
    if (branch) return new Response(JSON.stringify({ name: branch[1] }), { status: 200 });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return new Response(JSON.stringify({ full_name: url.pathname.slice(7), default_branch: "main" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }
  if (url.hostname === "api.cloudflare.com") return new Response(JSON.stringify({ success: true }), { status: 200 });
  return new Response('{"success":true}');
}

const site = await startSite({
  index: readWikiFile(), publicStatus: true, queue: true, outbound,
  bindings: { GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "ghp_test", CF_ZONE_ID: "zone-1", CF_API_TOKEN: "cf_test" }
});
const browser = await launchBrowser({ serviceWorkers: "allow" });   // so the check's offline lines are ✓
const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, colorScheme: "light" });
const page = await context.newPage();
const ready = async () => {
  await page.waitForFunction(() => window.$tw && $tw.syncer && $tw.syncer.timestampLastSyncFromServer, null, { timeout: 30000 });
  await settle(page);
};
await page.goto(site.base + "/");
await ready();

// A wiki with something in it
const add = fields => page.evaluate(f => $tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(), f, $tw.wiki.getModificationFields())), fields);
await add({ title: "$:/SiteTitle", text: "Field notes" });
await add({ title: "$:/SiteSubtitle", text: "a wiki on Cloudflare" });
await add({ title: "Welcome", text: "Edited here, behind Cloudflare Access; read by anyone at the public address. Every save is a commit in the backup repository.", tags: "notes" });
await add({ title: "Sourdough starter", text: "Day 3: bubbles after six hours. Feed 1:1:1 in the morning.", tags: "kitchen" });
await add({ title: "Reading list", text: "* The Dispossessed\n* A Pattern Language\n* Thinking in Systems", tags: "notes" });
await add({ title: "$:/DefaultTiddlers", text: "[[Welcome]]" });
await settle(page);
// Two more loads: the published page, then the service worker in control of it
await page.reload();
await ready();
await page.reload();
await ready();

// The Control Panel on Saving → Cloudflare, the check run, its lines in
await page.evaluate(() => new $tw.Story().navigateTiddler("$:/ControlPanel"));
await page.locator('button[role="tab"][data-tab-title="$:/core/ui/ControlPanel/Saving"]').first().click();
await page.locator('button[role="tab"]', { hasText: /^Cloudflare$/ }).first().click();
await page.locator("button", { hasText: /^Check the setup$/ }).first().click();
const checked = await waitFor(() => page.evaluate(() => { const t = $tw.wiki.getTiddler("$:/temp/cfworker/setup-check"); return !!t && t.fields.checked !== undefined; }), 20000);
if (!checked) throw new Error("the setup check didn't finish");
// The backup hint (shown once while no full backup has run) closed, as a reader would
await page.evaluate(() => $tw.wiki.filterTiddlers("[tag[$:/tags/Alert]]").forEach(t => $tw.wiki.deleteTiddler(t)));
await page.evaluate(() => window.scrollTo(0, 0));
await new Promise(r => setTimeout(r, 1500));
const lines = await page.evaluate(() => $tw.wiki.renderTiddler("text/plain", "$:/temp/cfworker/ControlPanel").match(/[✓✗–] [^✓✗–]+/g) || []);
const wrong = lines.filter(l => !l.startsWith("✓"));
if (wrong.length) {
  console.error(`NOT taken: ${wrong.length} of ${lines.length} lines in the check aren't fine: ${wrong.join(" | ")} (${OUT} left as it is)`);
} else {
  await page.screenshot({ path: OUT });
  console.log(`${OUT}: ${lines.length} lines in the check, all fine`);
}
await browser.close();
await site.close();
process.exit(wrong.length ? 1 : 0);
