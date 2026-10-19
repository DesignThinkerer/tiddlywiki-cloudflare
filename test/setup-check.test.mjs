// The setup check (design 1.13): GET /setup/check looks at each piece of the setup from the worker
// and reports it, a missing or wrong one naming the setup guide's section that fixes it, with its link. The worker runs
// behind the public stand-in (the rewrite rule, the CORS rule's two paths and the cache rules as
// Cloudflare's edge applies them) with GitHub and Cloudflare's API imitated. No browser.
// Run: npm run test:setup
import fs from "node:fs";
import { createChecks, readWikiFile, startSite } from "./browser-harness.mjs";

const { check, results } = createChecks();

// GitHub and Cloudflare's API, as the worker sees them; what the suite makes them answer
const api = { repo: 200, branch: 200, purge: { status: 200, body: { success: true } }, purgeDown: false };
const calls = [];   // the worker's own requests to them: "METHOD url"
function outbound(request) {
  const url = new URL(request.url);
  calls.push(`${request.method} ${url.href}`);
  if (url.hostname === "api.github.com") {
    const branch = url.pathname.match(/\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/);
    if (branch) return new Response(api.branch === 200 ? JSON.stringify({ name: branch[1] }) : JSON.stringify({ message: "Branch not found" }), { status: api.branch });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return new Response(api.repo === 200 ? JSON.stringify({ full_name: url.pathname.slice(7), default_branch: "main" }) : JSON.stringify({ message: api.repo === 401 ? "Bad credentials" : api.repo === 403 ? "API rate limit exceeded" : "Not Found" }), { status: api.repo });
    }
    return new Response("{}", { status: 404 });
  }
  if (url.hostname === "api.cloudflare.com") {
    // The API not answering at all: the worker's fetch fails before any answer. (A handler that throws, or a
    // Response.error(), reaches the worker as a 500 from Miniflare; a redirect loop is a network error there too)
    if (api.purgeDown) return Response.redirect(request.url, 302);
    return new Response(JSON.stringify(api.purge.body), { status: api.purge.status });
  }
  return new Response("not imitated: " + url.href, { status: 500 });
}
let corsOff = [];        // the paths the CORS header is left off (a rule scoped short): "/recipes/", "/_plugins/"
let rewriteOff = false;  // the public site's / serving something else than the page
let cacheStatus = "HIT";   // or a function of the URL: one status per path
let etagOff = false, lastModifiedOff = false;   // the page's ETag, then its Last-Modified too, removed by Cloudflare
let earlierBuild = null;   // { body, headers }: an earlier build of the page served at /, from Cloudflare's cache
const site = await startSite({
  index: readWikiFile(), publicStatus: true, queue: true, outbound,
  bindings: { GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "ghp_test", CF_ZONE_ID: "zone-1", CF_API_TOKEN: "cf_test" },
  publicSite: {
    cors: url => !corsOff.some(prefix => url.pathname.startsWith(prefix)),
    cacheStatus: url => typeof cacheStatus === "function" ? cacheStatus(url) : cacheStatus,
    etag: url => !(etagOff && url.pathname === "/"),
    lastModified: url => !(lastModifiedOff && url.pathname === "/"),
    override: (key, url) => url.pathname !== "/" ? undefined : rewriteOff ? "<!doctype html><html><body>a directory listing, say</body></html>" : earlierBuild || undefined
  }
});
const { base: BASE } = site;
await (await fetch(BASE + "/")).arrayBuffer();   // the page built once (and the core file, the status file)
await new Promise(r => setTimeout(r, 500));

async function run() {
  calls.length = 0;
  const res = await fetch(BASE + "/setup/check");
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text, items: Object.fromEntries((body?.checks || []).map(c => [c.id, c])) };
}
const line = (items, id) => items[id] ? `${items[id].ok} "${items[id].text}"` : "missing";
const ok = (items, id) => items[id] ? items[id].ok : "missing";
const text = (items, id) => items[id] ? items[id].text : "";
const guide = (items, id) => items[id] && items[id].guide ? items[id].guide.section : "";
const PUBLIC_HOST = new URL(site.pub).host;   // what the zone's rules name: "when the host is …"
// The five public-site lines, each naming the piece it stands for, on a private wiki and when the
// public site doesn't answer, so the list doesn't read as one sentence five times
const PIECES = { public: /^The public site:/, rewrite: /^The rewrite rule:/, "cors-reads": /^The CORS rule, tiddler reads:/, "cors-files": /^The CORS rule, files:/, cache: /^The cache rules:/ };

// --- 1. Everything in place -------------------------------------------------------------------------
let { status, body, items } = await run();
const IDS = ["access", "public", "rewrite", "cors-reads", "cors-files", "cache", "backups", "queue", "purges"];
check("GET /setup/check answers the list of pieces, each with ok, a line of text and the section of the setup guide that fixes it, with its link", status === 200 && !!body && IDS.every(id => items[id] && "ok" in items[id] && typeof items[id].text === "string" && items[id].guide && typeof items[id].guide.section === "string" && items[id].guide.text === `setup ${items[id].guide.section}` && /^https:\/\/.+\/docs\/setup\.md#/.test(items[id].guide.url)),
  `${status}: ${IDS.map(id => `${id}=${items[id] ? JSON.stringify(items[id].guide) : "missing"}`).join(" ")}`);
// The link's anchor is a heading of docs/setup.md, the one the section number names (GitHub's slug:
// lower case, punctuation dropped, spaces to hyphens), so the link can't go stale without this failing
const setupHeadings = new Set([...fs.readFileSync(new URL("../docs/setup.md", import.meta.url), "utf8").matchAll(/^#{1,6} (.+)$/gm)]
  .map(m => m[1].toLowerCase().replace(/[`*_]/g, "").replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/ /g, "-")));
check("each line's link points at the heading of docs/setup.md its section number names", IDS.every(id => {
  const g = items[id] && items[id].guide, a = g && /\/docs\/setup\.md#([a-z0-9-]+)$/.exec(g.url);
  return !!a && setupHeadings.has(a[1]) && a[1].startsWith(g.section.replace(".", "") + "-");
}), IDS.map(id => `${id}: ${items[id] && items[id].guide ? items[id].guide.url : "none"}`).join(" "));
check("everything in place: every piece fine, the lines saying so", IDS.every(id => items[id] && items[id].ok === true),
  IDS.filter(id => !items[id] || items[id].ok !== true).map(id => `${id}: ${line(items, id)}`).join(" | "));
check("...the public site asked for the page, the tiddler list, the core file and the status file, with the admin site as Origin",
  site.publicRequests.some(p => p === "/") && site.publicRequests.some(p => p.startsWith("/recipes/default/tiddlers.json")) && site.publicRequests.some(p => p.startsWith("/_plugins/tiddlywikicore.js")) && site.publicRequests.includes("/status"),
  site.publicRequests.join(", "));
check("...GitHub asked for the repository and its branch with the token, Cloudflare asked to purge the status file's cached copy",
  calls.some(c => c === "GET https://api.github.com/repos/someone/wiki-backup") && calls.some(c => c === "GET https://api.github.com/repos/someone/wiki-backup/branches/main") &&
  calls.some(c => c === "POST https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache"), calls.join(", "));
check("...the purges line says the status file's copy was purged, the backups line names the repository and the branch",
  /status/.test(text(items, "purges")) && /someone\/wiki-backup/.test(text(items, "backups")) && /main/.test(text(items, "backups")), `${line(items, "purges")} ${line(items, "backups")}`);

// --- 2. The public site's rules, one missing at a time --------------------------------------------
rewriteOff = true;
({ items } = await run());
check("the rewrite rule missing (the public site's / isn't the page): named, with setup 2.7; the other lines fine",
  ok(items, "rewrite") === false && /rewrite/i.test(text(items, "rewrite")) && guide(items, "rewrite") === "2.7" && ok(items, "public") === true && ok(items, "cors-reads") === true && ok(items, "cors-files") === true,
  `${line(items, "rewrite")} | public ${ok(items, "public")}`);
check("...and the line ends with what to do: the rule's place (Rules → Transform Rules → Rewrite URL), the host, the path / rewritten to /baked.html",
  /Rules → Transform Rules → Rewrite URL/.test(text(items, "rewrite")) && text(items, "rewrite").includes(`the host is ${PUBLIC_HOST}`) && /rewrite the path to \/baked\.html\.$/.test(text(items, "rewrite")), line(items, "rewrite"));
rewriteOff = false;
// Cloudflare removes an HTML answer's ETag when a feature of the zone rewrites the page (Email Address
// Obfuscation is on by default): the page is then known by its date, and failing that by its content
etagOff = true;
({ items } = await run());
check("the page's ETag removed by Cloudflare (a zone feature rewriting HTML): the rewrite line still passes, the page known by its Last-Modified", ok(items, "rewrite") === true, line(items, "rewrite"));
lastModifiedOff = true;
({ items } = await run());
check("...ETag and Last-Modified both gone: known by its content, the worker's own mark in the page", ok(items, "rewrite") === true, line(items, "rewrite"));
rewriteOff = true;
({ items } = await run());
check("...and with neither header, something else at /: still a failure, saying what was found (the status, no ETag, no Last-Modified)", ok(items, "rewrite") === false && /no ETag/.test(text(items, "rewrite")) && /no Last-Modified/.test(text(items, "rewrite")), line(items, "rewrite"));
rewriteOff = false;
etagOff = false;
lastModifiedOff = false;
// Cloudflare's cache serving an earlier build of the page (rebuilt since: a plugin installed, the
// engine updated; the copy is purged at the next save, or expires with the cache rule's TTL): the
// wiki page all the same, so the rule is in place, and the line says what it found
const currentPage = await (await fetch(site.pub + "/")).text();
earlierBuild = { body: currentPage, headers: { "Content-Type": "text/html; charset=utf-8", ETag: '"0123456789abcdef0123456789abcdef"', "Last-Modified": new Date(Date.now() - 86400000).toUTCString() } };
({ items } = await run());
check("an earlier build of the page at / (Cloudflare's cached copy, its ETag not the stored page's): the rewrite line passes, saying it's an earlier build from the cache",
  ok(items, "rewrite") === true && /earlier build/i.test(text(items, "rewrite")) && /cache/i.test(text(items, "rewrite")), line(items, "rewrite"));
delete earlierBuild.headers.ETag;
({ items } = await run());
check("...with no ETag and an older Last-Modified: the same", ok(items, "rewrite") === true && /earlier build/i.test(text(items, "rewrite")), line(items, "rewrite"));
earlierBuild = null;
corsOff = ["/_plugins/"];
({ items } = await run());
check("the CORS header missing under /_plugins/ only: the files line fails naming that path and setup 2.7, the reads line passes",
  ok(items, "cors-files") === false && /_plugins/.test(text(items, "cors-files")) && guide(items, "cors-files") === "2.7" && ok(items, "cors-reads") === true,
  `${line(items, "cors-files")} | ${line(items, "cors-reads")}`);
check("...and the files line ends with what to do: add the path to the rule's When (Rules → Transform Rules → Modify Response Header), the host and both paths named",
  /Add the path to the rule's When/.test(text(items, "cors-files")) && /Rules → Transform Rules → Modify Response Header/.test(text(items, "cors-files")) && text(items, "cors-files").includes(`the host is ${PUBLIC_HOST}`) && /\/recipes\/ or \/_plugins\/\.$/.test(text(items, "cors-files")), line(items, "cors-files"));
corsOff = ["/recipes/", "/_plugins/"];
({ items } = await run());
check("...missing on both paths: both lines fail, the reads one naming /recipes/", ok(items, "cors-files") === false && ok(items, "cors-reads") === false && /recipes/.test(text(items, "cors-reads")),
  `${line(items, "cors-reads")} | ${line(items, "cors-files")}`);
check("...and the reads line ends with what to do: the rule's place (Rules → Transform Rules → Modify Response Header), the host, its two paths, and the admin site's origin to set Access-Control-Allow-Origin to",
  /Rules → Transform Rules → Modify Response Header/.test(text(items, "cors-reads")) && text(items, "cors-reads").includes(`the host is ${PUBLIC_HOST}`) && /\/recipes\/ or \/_plugins\//.test(text(items, "cors-reads")) && text(items, "cors-reads").endsWith(`set Access-Control-Allow-Origin to ${BASE}.`), line(items, "cors-reads"));
corsOff = [];
cacheStatus = "DYNAMIC";
({ items } = await run());
check("no cache rule on the public site (DYNAMIC): reported with what was found, not a failure", ok(items, "cache") === null && /DYNAMIC/.test(text(items, "cache")) && guide(items, "cache") === "2.7", line(items, "cache"));
check("...and the line ends with the rules to add (Rules → Cache Rules), by the setup guide's names: \"Cache public wiki\" for the page, \"Cache plugin files\" for the core file, \"Cache status file\" for the status file, as optional",
  /Rules → Cache Rules/.test(text(items, "cache")) && /\(optional\)/.test(text(items, "cache")) && /"Cache public wiki" for the page, "Cache plugin files" for the core and plugin files, "Cache status file" for the status file\.$/.test(text(items, "cache")), line(items, "cache"));
cacheStatus = url => url.pathname.startsWith("/_plugins/") ? "DYNAMIC" : "HIT";
({ items } = await run());
check("...the core file alone DYNAMIC: \"Cache plugin files\" named alone", ok(items, "cache") === null && /"Cache plugin files"/.test(text(items, "cache")) && !/"Cache public wiki"/.test(text(items, "cache")) && !/"Cache status file"/.test(text(items, "cache")), line(items, "cache"));
cacheStatus = "HIT";
({ items } = await run());
check("...cached: the line says so", ok(items, "cache") === true && /HIT/.test(text(items, "cache")), line(items, "cache"));
await site.stopPublic();
({ items } = await run());
check("the public site not answering: its line says so with setup 2.2, the rule lines left unchecked", ok(items, "public") === false && guide(items, "public") === "2.2" && ok(items, "rewrite") === null && ok(items, "cors-reads") === null && ok(items, "cors-files") === null,
  `${line(items, "public")} | rewrite ${ok(items, "rewrite")}`);
check("...and the public line ends with what to do: connect the domain to the bucket (R2 → the bucket → Settings → Custom Domains) and set PUBLIC_WIKI_URL in the worker's Variables and Secrets",
  /Connect the domain to the bucket \(R2 → the bucket → Settings → Custom Domains/.test(text(items, "public")) && /set PUBLIC_WIKI_URL, in the worker's Variables and Secrets, to https:\/\/ and that domain/.test(text(items, "public")), line(items, "public"));
const unchecked = ["rewrite", "cors-reads", "cors-files", "cache"];
check("...and the four unchecked lines each name their piece (the rewrite rule, the CORS rule's two paths, the cache rules), four different lines rather than one sentence four times",
  unchecked.every(id => PIECES[id].test(text(items, id)) && /not checked/i.test(text(items, id))) && new Set(unchecked.map(id => text(items, id))).size === 4, unchecked.map(id => line(items, id)).join(" | "));
await site.startPublic();

// --- 3. Backups, the queue, purges ------------------------------------------------------------------
api.repo = 401;
({ items } = await run());
check("GitHub refusing the token (401): the backups line says so, with setup 2.4", ok(items, "backups") === false && /401|token/.test(text(items, "backups")) && guide(items, "backups") === "2.4", line(items, "backups"));
api.repo = 404;
({ items } = await run());
check("GitHub not finding the repository with the token (404): named", ok(items, "backups") === false && /404|find/.test(text(items, "backups")), line(items, "backups"));
check("...and the line ends with what to check: GITHUB_REPO (owner/repo) and the token's Repository access on GitHub, under its fine-grained tokens",
  /Check GITHUB_REPO \(owner\/repo/.test(text(items, "backups")) && /Repository access/.test(text(items, "backups")) && /Fine-grained tokens/.test(text(items, "backups")), line(items, "backups"));
api.repo = 403;
({ items } = await run());
check("GitHub answering something else (403, a rate limit): the line gives the status and GitHub's message, says to check again in a moment, and where to look on GitHub if it stays, with setup 2.4",
  ok(items, "backups") === false && /403/.test(text(items, "backups")) && /API rate limit exceeded/.test(text(items, "backups")) && /again in a moment/.test(text(items, "backups")) && /Fine-grained tokens/.test(text(items, "backups")) && guide(items, "backups") === "2.4", line(items, "backups"));
api.repo = 200;
api.branch = 404;
({ items } = await run());
check("the branch missing: named", ok(items, "backups") === false && /branch/.test(text(items, "backups")) && /main/.test(text(items, "backups")), line(items, "backups"));
check("...and the line ends with what to do: set GITHUB_BRANCH, in the worker's Variables and Secrets, to a branch the repository has, or give an empty repository its first commit",
  /Set GITHUB_BRANCH, in the worker's Variables and Secrets/.test(text(items, "backups")) && /first commit/.test(text(items, "backups")), line(items, "backups"));
api.branch = 200;
api.purge = { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } };
({ items } = await run());
check("Cloudflare refusing the purge: the purges line says so, with the token's section", ok(items, "purges") === false && /Authentication error|403/.test(text(items, "purges")) && guide(items, "purges") === "2.5", line(items, "purges"));
check("...and the line ends with what to check: CF_ZONE_ID against the zone ID on the domain's overview page, the token under My Profile → API Tokens, a new one put in the CF_API_TOKEN secret",
  /Check CF_ZONE_ID against the zone ID on the domain's overview page/.test(text(items, "purges")) && /My Profile → API Tokens/.test(text(items, "purges")) && /put in the CF_API_TOKEN secret/.test(text(items, "purges")), line(items, "purges"));
api.purge = { status: 200, body: { success: true } };
api.purgeDown = true;
({ items } = await run());
check("Cloudflare's API not answering the purge at all: the line says so, with the error, and to check again in a moment, with setup 2.5",
  ok(items, "purges") === false && /didn't answer/.test(text(items, "purges")) && /again in a moment/.test(text(items, "purges")) && guide(items, "purges") === "2.5", line(items, "purges"));
api.purgeDown = false;
await site.setBindings({ GITHUB_REPO: "", GITHUB_TOKEN: "", CF_ZONE_ID: "", CF_API_TOKEN: "" });
({ items } = await run());
check("backups not set up: the line says so with setup 2.4; no purge token: an optional piece, not a failure",
  ok(items, "backups") === false && guide(items, "backups") === "2.4" && /GITHUB_REPO/.test(text(items, "backups")) && ok(items, "purges") === null && /CF_ZONE_ID/.test(text(items, "purges")),
  `${line(items, "backups")} | ${line(items, "purges")}`);
check("...and the backups line ends with what to do: a repository and a fine-grained token with Contents read and write, then GITHUB_REPO (owner/repo) and the GITHUB_TOKEN secret in the worker's Variables and Secrets; backups said to be optional",
  /no GITHUB_REPO and no GITHUB_TOKEN \(optional/.test(text(items, "backups")) && /fine-grained token limited to it, with Contents read and write/.test(text(items, "backups")) && /set GITHUB_REPO \(owner\/repo\) and the GITHUB_TOKEN secret in the worker's Variables and Secrets\.$/.test(text(items, "backups")), line(items, "backups"));
check("...and the purges line ends with what to set: CF_ZONE_ID (the zone ID on the domain's overview page) and the CF_API_TOKEN secret (a token from My Profile → API Tokens with Zone → Cache Purge), in the worker's Variables and Secrets",
  /CF_ZONE_ID and CF_API_TOKEN aren't set/.test(text(items, "purges")) && /CF_ZONE_ID \(the zone ID on the domain's overview page\)/.test(text(items, "purges")) && /CF_API_TOKEN secret \(a token from My Profile → API Tokens with Zone → Cache Purge on that zone\) in the worker's Variables and Secrets\.$/.test(text(items, "purges")), line(items, "purges"));
check("(the queue is bound here)", ok(items, "queue") === true, line(items, "queue"));
await site.setBindings({ GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "", CF_ZONE_ID: "zone-1", CF_API_TOKEN: "" });
({ items } = await run());
check("the token missing of each pair, the other set: the backups line names GITHUB_TOKEN alone, with the repository, and says to make a token limited to it; the purges line names CF_API_TOKEN alone and says to set that secret",
  ok(items, "backups") === false && /has GITHUB_REPO \(someone\/wiki-backup\) but no GITHUB_TOKEN/.test(text(items, "backups")) && /Make a fine-grained token limited to that repository/.test(text(items, "backups")) && /put it in the GITHUB_TOKEN secret/.test(text(items, "backups")) &&
  ok(items, "purges") === null && /CF_API_TOKEN isn't set \(CF_ZONE_ID is\)/.test(text(items, "purges")) && /set the CF_API_TOKEN secret, in the worker's Variables and Secrets/.test(text(items, "purges")) && !/overview page/.test(text(items, "purges")),
  `${line(items, "backups")} | ${line(items, "purges")}`);
await site.setBindings({ GITHUB_REPO: "", GITHUB_TOKEN: "ghp_test", CF_ZONE_ID: "", CF_API_TOKEN: "cf_test" });
({ items } = await run());
check("...the other way round: the backups line names GITHUB_REPO alone and says to set it to the repository the token is limited to; the purges line names CF_ZONE_ID alone and where its value is",
  ok(items, "backups") === false && /has GITHUB_TOKEN but no GITHUB_REPO/.test(text(items, "backups")) && /Set GITHUB_REPO, in the worker's Variables and Secrets/.test(text(items, "backups")) &&
  ok(items, "purges") === null && /CF_ZONE_ID isn't set \(CF_API_TOKEN is\)/.test(text(items, "purges")) && /set CF_ZONE_ID, in the worker's Variables and Secrets, to the zone ID on the domain's overview page\.$/.test(text(items, "purges")),
  `${line(items, "backups")} | ${line(items, "purges")}`);
await site.close();

// --- 4. A worker without the queue, a private wiki --------------------------------------------------
const noQueue = await startSite({ index: readWikiFile(), publicStatus: true, outbound, bindings: { GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "ghp_test" } });
await (await fetch(noQueue.base + "/")).arrayBuffer();
{
  const res = await fetch(noQueue.base + "/setup/check");
  const items = Object.fromEntries(((await res.json()).checks || []).map(c => [c.id, c]));
  check("the queue not bound: its line says so, with setup 2.3", items.queue && ok(items, "queue") === false && guide(items, "queue") === "2.3", line(items, "queue"));
}
await noQueue.close();
const priv = await startSite({ index: readWikiFile(), publicStatus: true, privateWiki: true, outbound });
await (await fetch(priv.base + "/")).arrayBuffer();
{
  const res = await fetch(priv.base + "/setup/check");
  const items = Object.fromEntries(((await res.json()).checks || []).map(c => [c.id, c]));
  check("a private wiki: the public site's lines say there's nothing to check (setup 2.1), Access fine, purges nothing to purge",
    ["public", "rewrite", "cors-reads", "cors-files", "cache", "purges"].every(id => items[id] && items[id].ok === null) && /private/i.test(text(items, "public")) && ok(items, "access") === true,
    ["public", "rewrite", "cors-reads", "cors-files", "cache", "purges"].map(id => `${id}: ${line(items, id)}`).join(" | "));
  // (Five slots, one per piece, as on a public wiki; each names the piece it stands for, so the list
  // doesn't read as one sentence five times)
  const privateTexts = Object.keys(PIECES).map(id => text(items, id));
  check("...and each of the five public-site lines names its piece (the site, the rewrite rule, the CORS rule's two paths, the cache rules), five different lines rather than one sentence five times, each with setup 2.1",
    Object.entries(PIECES).every(([id, re]) => re.test(text(items, id)) && /nothing to check/.test(text(items, id)) && guide(items, id) === "2.1") && new Set(privateTexts).size === 5,
    privateTexts.join(" | "));
}
await priv.close();

console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(results.every(r => r.ok) ? 0 : 1);
