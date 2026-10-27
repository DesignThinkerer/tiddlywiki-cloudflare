// The setup check (design 1.13): GET /setup/check looks at each piece of the setup from the worker
// and reports it, a missing or wrong one naming the setup guide's section that fixes it, with its link. The worker runs
// behind the public stand-in (the rewrite rule, the CORS rule's two paths and the cache rules as
// Cloudflare's edge applies them) with GitHub and Cloudflare's API imitated. No browser.
// Run: npm run test:setup
import fs from "node:fs";
import { createChecks, readWikiFile, startSite } from "./browser-harness.mjs";
import { setupCheck } from "../src/worker/setup.js";

const { check, results } = createChecks();

// GitHub and Cloudflare's API, as the worker sees them; what the suite makes them answer
const api = { repo: 200, branch: 200, private: true, purge: { status: 200, body: { success: true } }, purgeDown: false };   // private: the backup repository's visibility
const calls = [];   // the worker's own requests to them: "METHOD url"
function outbound(request) {
  const url = new URL(request.url);
  calls.push(`${request.method} ${url.href}`);
  if (url.hostname === "api.github.com") {
    const branch = url.pathname.match(/\/repos\/[^/]+\/[^/]+\/branches\/(.+)$/);
    if (branch) return new Response(api.branch === 200 ? JSON.stringify({ name: branch[1] }) : JSON.stringify({ message: "Branch not found" }), { status: api.branch });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return new Response(api.repo === 200 ? JSON.stringify({ full_name: url.pathname.slice(7), default_branch: "main", private: api.private, visibility: api.private ? "private" : "public" }) : JSON.stringify({ message: api.repo === 401 ? "Bad credentials" : api.repo === 403 ? "API rate limit exceeded" : "Not Found" }), { status: api.repo });
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
let corsValue = null;    // the CORS header's value when not the admin site's origin (a rule set wrong)
let edgeStatus = null;   // a status Cloudflare's edge answers every path with (530 while the domain initialises)
let emptyBucket = false; // the domain on another bucket than the worker's: every path R2's 404
let rewriteOff = false;  // the public site's / serving something else than the page
let cacheStatus = "HIT";   // or a function of the URL: one status per path
let etagOff = false, lastModifiedOff = false;   // the page's ETag, then its Last-Modified too, removed by Cloudflare
let earlierBuild = null;   // { body, headers }: an earlier build of the page served at /, from Cloudflare's cache
const site = await startSite({
  index: readWikiFile(), publicStatus: true, queue: true, outbound,
  bindings: { GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "ghp_test", CF_ZONE_ID: "zone-1", CF_API_TOKEN: "cf_test" },
  publicSite: {
    cors: url => !corsOff.some(prefix => url.pathname.startsWith(prefix)) && (corsValue || true),
    cacheStatus: url => typeof cacheStatus === "function" ? cacheStatus(url) : cacheStatus,
    etag: url => !(etagOff && url.pathname === "/"),
    lastModified: url => !(lastModifiedOff && url.pathname === "/"),
    override: (key, url) => edgeStatus ? { status: edgeStatus, body: `error code: ${edgeStatus}`, headers: { "Content-Type": "text/plain" } }
      : emptyBucket ? { status: 404, body: "<Error><Code>NoSuchKey</Code><Message>Object not found</Message></Error>", headers: { "Content-Type": "application/xml" } }
      : url.pathname !== "/" ? undefined : rewriteOff ? "<!doctype html><html><body>a directory listing, say</body></html>" : earlierBuild || undefined
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
// A line's words: what was found and, when the worker gives one, the one thing to do, its own field
// `todo`, which the tab shows on its own line (design 2.20); `said` is the text alone
const text = (items, id) => items[id] ? items[id].text + (items[id].todo ? " " + items[id].todo : "") : "";
const said = (items, id) => items[id] ? items[id].text : "";
const todoOf = (items, id) => items[id] && typeof items[id].todo === "string" ? items[id].todo : "";
const guide = (items, id) => items[id] && items[id].guide ? items[id].guide.section : "";
const PUBLIC_HOST = new URL(site.pub).host;   // what the zone's rules name: "when the host is …"
// The five public-site lines, each naming the piece it stands for, when the public site doesn't
// answer, so the list doesn't read as one sentence five times (a private wiki gets one line: section 4)
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
// The one thing to do is the worker's own field, todo, beside the text (the tab shows it on its own
// line): a passing line has none, but the cache line, information, may carry its optional one
check("...a passing line carries no todo (the cache line apart, whose optional one is information), and the queue line is plain: in place, its binding named",
  ["access", "public", "rewrite", "cors-reads", "cors-files", "backups", "queue", "purges"].every(id => !todoOf(items, id)) && /^The backup queue is in place \(BACKUP_QUEUE\)\.$/.test(said(items, "queue")),
  `queue ${line(items, "queue")} | todos ${IDS.map(id => `${id}=${JSON.stringify(todoOf(items, id))}`).join(" ")}`);
check("...the Access line, on this local address with ACCESS = off: says the switch is on and that a deployed worker refuses without Access",
  ok(items, "access") === true && /ACCESS = off/.test(text(items, "access")) && /deployed worker refuses/.test(text(items, "access")), line(items, "access"));
// A request Access did authenticate, which Miniflare can't make: the worker's own function, with the
// mark Access sets and the e-mail header it adds to each request it passes (a private wiki's
// environment: no public site, backups and purges unset, so nothing is asked of anyone)
const through = async (headers, ctx) => {
  const res = await setupCheck(new Request("https://wiki-admin.someone.workers.dev/setup/check", { headers }), {}, ctx, {});
  const body = await res.json();
  return Object.fromEntries(body.checks.map(c => [c.id, c]));
};
const marked = await through({ "Cf-Access-Authenticated-User-Email": "me@example.com" }, { access: { aud: "app" } });
check("a request Access let through (the mark, and its e-mail header): the Access line passes, names whom Access let in, and says the policy itself isn't checked, with where it should allow you alone",
  ok(marked, "access") === true && /me@example\.com/.test(text(marked, "access")) && /policy itself isn't checked/.test(text(marked, "access")) && /allow you alone/.test(text(marked, "access")) && /Access tab|Zero Trust/.test(text(marked, "access")) && !/ACCESS = off/.test(text(marked, "access")),
  line(marked, "access"));
const identified = await through({}, { access: { aud: "app", getIdentity: async () => ({ email: "member@example.com", name: "A member" }) } });
check("...without the header, Cloudflare's own identity read (ctx.access.getIdentity) names whom Access let in", ok(identified, "access") === true && /member@example\.com/.test(text(identified, "access")), line(identified, "access"));
const unnamed = await through({}, { access: { aud: "app", getIdentity: async () => { throw new Error("no identity (test)"); } } });
check("...with neither the header nor an identity: the line still passes and says the policy isn't checked, naming nobody",
  ok(unnamed, "access") === true && /policy itself isn't checked/.test(text(unnamed, "access")) && !/@/.test(text(unnamed, "access")), line(unnamed, "access"));
check("...the public site asked for the page, the tiddler list, the core file and the status file, with the admin site as Origin",
  site.publicRequests.some(p => p === "/") && site.publicRequests.some(p => p.startsWith("/recipes/default/tiddlers.json")) && site.publicRequests.some(p => p.startsWith("/_plugins/tiddlywikicore.js")) && site.publicRequests.includes("/status"),
  site.publicRequests.join(", "));
check("...GitHub asked for the repository and its branch with the token, Cloudflare asked to purge the status file's cached copy",
  calls.some(c => c === "GET https://api.github.com/repos/someone/wiki-backup") && calls.some(c => c === "GET https://api.github.com/repos/someone/wiki-backup/branches/main") &&
  calls.some(c => c === "POST https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache"), calls.join(", "));
check("...the purges line says the status file's copy was purged, the backups line names the repository and the branch, and says what the check can't test, writing, with the next step: save any tiddler, and the tab's Backups section and an alert say if GitHub refuses it",
  /status/.test(text(items, "purges")) && /someone\/wiki-backup/.test(text(items, "backups")) && /main/.test(text(items, "backups")) && /GitHub accepts the token\. The check can't test writing: save any tiddler, and if GitHub refuses it, the tab's Backups section and an alert say so within minutes\.$/.test(text(items, "backups")) && !/Whether it may write/.test(text(items, "backups")),
  `${line(items, "purges")} ${line(items, "backups")}`);

// --- 2. The public site's rules, one missing at a time --------------------------------------------
rewriteOff = true;
({ items } = await run());
check("the rewrite rule missing (the public site's / isn't the page): named, with setup 2.7; the other lines fine",
  ok(items, "rewrite") === false && /rewrite/i.test(text(items, "rewrite")) && guide(items, "rewrite") === "2.7" && ok(items, "public") === true && ok(items, "cors-reads") === true && ok(items, "cors-files") === true,
  `${line(items, "rewrite")} | public ${ok(items, "public")}`);
check("...and the line ends with what to do: the rule's place (Rules → Transform Rules → Rewrite URL), the host, the path / rewritten to /baked.html",
  /Rules → Transform Rules → Rewrite URL/.test(text(items, "rewrite")) && text(items, "rewrite").includes(`the host is ${PUBLIC_HOST}`) && /rewrite the path to \/baked\.html\.$/.test(text(items, "rewrite")), line(items, "rewrite"));
check("...that action as the line's own todo field, the text ending at what was found, the evidence (status, ETag, Last-Modified, the stored page's) after the diagnosis rather than before it",
  /^Add it under the domain, Rules → Transform Rules → Rewrite URL: when the host is /.test(todoOf(items, "rewrite")) && !/Add it under/.test(said(items, "rewrite")) && /^The public site's \/ doesn't serve the wiki page: the rewrite rule \/ → \/baked\.html is missing or wrong \(answered \d+/.test(said(items, "rewrite")) && /\.$/.test(said(items, "rewrite")),
  `text ${JSON.stringify(said(items, "rewrite"))} | todo ${JSON.stringify(todoOf(items, "rewrite"))}`);
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
// The page's Browser TTL, read from the cache answer's Cache-Control (no request added): long, or
// missing (Cloudflare's default of four hours), it's said as information in the cache line, with why
// it matters and where to set it; short, the value is named. The mark doesn't change (design 2.20)
earlierBuild.headers["Cache-Control"] = "max-age=14400";
({ items } = await run());
check("the page's Browser TTL long (Cache-Control: max-age=14400): the cache line says it's 4 hours, that a visitor's browser, your own included, keeps a page that long after an edit and purges don't reach it, and to set Override, 5 minutes in the Cache public wiki rule (the line's own link, setup 2.7, says where); not a failure",
  ok(items, "cache") === true && /The page's Browser TTL is 4 hours \(Cache-Control: max-age=14400\): a visitor's browser, your own included, keeps a page that long after an edit, and purges don't reach it\. In the "Cache public wiki" rule, set Browser TTL to Override, 5 minutes\./.test(text(items, "cache")),
  line(items, "cache"));
earlierBuild.headers["Cache-Control"] = "max-age=300";
({ items } = await run());
check("...short (max-age=300): the line names it, 5 minutes, and nothing more", ok(items, "cache") === true && /The page's Browser TTL is 5 minutes \(Cache-Control: max-age=300\)\./.test(text(items, "cache")) && !/purges don't reach it/.test(text(items, "cache")), line(items, "cache"));
delete earlierBuild.headers["Cache-Control"];
({ items } = await run());
check("...missing (no Cache-Control header): Cloudflare's default of 4 hours applies, said so, with the rule to set", ok(items, "cache") === true && /The page has no Browser TTL \(no Cache-Control header\), so Cloudflare's default of 4 hours applies: a visitor's browser, your own included, keeps a page that long after an edit, and purges don't reach it\. In the "Cache public wiki" rule, set Browser TTL to Override, 5 minutes\./.test(text(items, "cache")), line(items, "cache"));
earlierBuild = null;
corsOff = ["/_plugins/"];
({ items } = await run());
check("the CORS header missing under /_plugins/ only: the files line fails naming that path and setup 2.7, the reads line passes",
  ok(items, "cors-files") === false && /_plugins/.test(text(items, "cors-files")) && guide(items, "cors-files") === "2.7" && ok(items, "cors-reads") === true,
  `${line(items, "cors-files")} | ${line(items, "cors-reads")}`);
check("...and the files line ends with what to do: add the path to the rule's When (Rules → Transform Rules → Modify Response Header), the host and both paths named",
  /Add the path to the rule's When/.test(text(items, "cors-files")) && /Rules → Transform Rules → Modify Response Header/.test(text(items, "cors-files")) && text(items, "cors-files").includes(`the host is ${PUBLIC_HOST}`) && /\/recipes\/ or \/_plugins\/\.$/.test(text(items, "cors-files")), line(items, "cors-files"));
check("...as its own todo field, the text ending at the consequence", /^Add the path to the rule's When/.test(todoOf(items, "cors-files")) && /doesn't open offline on a device that doesn't have them\.$/.test(said(items, "cors-files")) && !/Add the path/.test(said(items, "cors-files")),
  `text ${JSON.stringify(said(items, "cors-files"))} | todo ${JSON.stringify(todoOf(items, "cors-files"))}`);
corsOff = ["/recipes/", "/_plugins/"];
({ items } = await run());
check("...missing on both paths: both lines fail, the reads one naming /recipes/", ok(items, "cors-files") === false && ok(items, "cors-reads") === false && /recipes/.test(text(items, "cors-reads")),
  `${line(items, "cors-reads")} | ${line(items, "cors-files")}`);
check("...and the reads line ends with what to do: the rule's place (Rules → Transform Rules → Modify Response Header), the host, its two paths, and the admin site's origin to set Access-Control-Allow-Origin to",
  /Rules → Transform Rules → Modify Response Header/.test(text(items, "cors-reads")) && text(items, "cors-reads").includes(`the host is ${PUBLIC_HOST}`) && /\/recipes\/ or \/_plugins\//.test(text(items, "cors-reads")) && text(items, "cors-reads").endsWith(`set Access-Control-Allow-Origin to ${BASE}.`), line(items, "cors-reads"));
corsOff = [];
// A header present with the wrong value (the origin with a trailing slash, http, the public hostname):
// the lines name the value found and the one to set, rather than calling the rule missing
corsValue = BASE + "/";
({ items } = await run());
check("the CORS header present with the wrong value (the admin site's origin with a trailing slash): both lines fail naming the value found and the exact value to set, the header's value to fix, not a rule to add",
  ok(items, "cors-reads") === false && ok(items, "cors-files") === false && [text(items, "cors-reads"), text(items, "cors-files")].every(t => t.includes(`sets Access-Control-Allow-Origin to ${BASE}/`) && t.includes(`must be exactly ${BASE}`) && /Fix the header's value/.test(t) && !/missing or doesn't cover/.test(t) && !/Add the path/.test(t)),
  `${line(items, "cors-reads")} | ${line(items, "cors-files")}`);
corsValue = null;
cacheStatus = "DYNAMIC";
({ items } = await run());
check("no cache rule on the public site (DYNAMIC): reported with what was found, not a failure", ok(items, "cache") === null && /DYNAMIC/.test(text(items, "cache")) && guide(items, "cache") === "2.7", line(items, "cache"));
check("...and the line ends with the rules to add (Rules → Cache Rules), by the setup guide's names: \"Cache public wiki\" for the page, \"Cache plugin files\" for the core file, \"Cache status file\" for the status file, as optional",
  /Rules → Cache Rules/.test(text(items, "cache")) && /\(optional\)/.test(text(items, "cache")) && /"Cache public wiki" for the page, "Cache plugin files" for the core and plugin files, "Cache status file" for the status file\.$/.test(text(items, "cache")), line(items, "cache"));
cacheStatus = url => url.pathname.startsWith("/_plugins/") ? "DYNAMIC" : "HIT";
({ items } = await run());
check("...the core file alone DYNAMIC: \"Cache plugin files\" named alone", ok(items, "cache") === null && /"Cache plugin files"/.test(text(items, "cache")) && !/"Cache public wiki" for the page/.test(text(items, "cache")) && !/"Cache status file"/.test(text(items, "cache")), line(items, "cache"));
cacheStatus = "HIT";
({ items } = await run());
check("...cached: the line says so", ok(items, "cache") === true && /HIT/.test(text(items, "cache")), line(items, "cache"));
await site.stopPublic();
({ items } = await run());
check("the public site not answering: its line says so with setup 2.2, the rule lines left unchecked", ok(items, "public") === false && guide(items, "public") === "2.2" && ok(items, "rewrite") === null && ok(items, "cors-reads") === null && ok(items, "cors-files") === null,
  `${line(items, "public")} | rewrite ${ok(items, "rewrite")}`);
check("...and the public line ends with what to do: check again in a few minutes if the domain was just connected, else connect the domain to the bucket (R2 → the bucket → Settings → Custom Domains) or correct PUBLIC_WIKI_URL, named with its value, in the worker's Variables and Secrets",
  /check the setup again in a few minutes/.test(text(items, "public")) && /connect the domain to the bucket \(R2 → the bucket → Settings → Custom Domains/.test(text(items, "public")) && text(items, "public").includes(`correct PUBLIC_WIKI_URL, in the worker's Variables and Secrets, now "${site.pub}", to https:// and that domain`), line(items, "public"));
check("...as its own todo field, the text one sentence on what was found", /^If you connected the domain to the bucket in the last few minutes/.test(todoOf(items, "public")) && /^The public site at \S+ (didn't answer \(.*\): nothing answers at PUBLIC_WIKI_URL|answered \d+: Cloudflare's edge, with no bucket behind the host yet)\.$/.test(said(items, "public")),
  `text ${JSON.stringify(said(items, "public"))} | todo ${JSON.stringify(todoOf(items, "public"))}`);
const unchecked = ["rewrite", "cors-reads", "cors-files", "cache"];
check("...and the four unchecked lines each name their piece (the rewrite rule, the CORS rule's two paths, the cache rules), four different lines rather than one sentence four times",
  unchecked.every(id => PIECES[id].test(text(items, id)) && /not checked/i.test(text(items, id))) && new Set(unchecked.map(id => text(items, id))).size === 4, unchecked.map(id => line(items, id)).join(" | "));
await site.startPublic();
// Cloudflare's edge answering 5xx in the minutes after the domain is connected (530, the commonest
// first check): named as the edge with no bucket behind the host yet, to check again in a few minutes,
// rather than "didn't answer (answered 530)" and the domain to connect
edgeStatus = 530;
({ items } = await run());
check("the public site answering 530 (Cloudflare's edge while the domain initialises): its line says so, names the edge, says to check again in a few minutes if the domain was just connected, else to connect it or correct the address, the rule lines unchecked",
  ok(items, "public") === false && /answered 530/.test(text(items, "public")) && /Cloudflare's edge/.test(text(items, "public")) && /check the setup again in a few minutes/.test(text(items, "public")) && !/didn't answer/.test(text(items, "public")) &&
  /connect the domain to the bucket \(R2 → the bucket → Settings → Custom Domains/.test(text(items, "public")) && text(items, "public").includes(`now "${site.pub}"`) && guide(items, "public") === "2.2" && unchecked.every(id => ok(items, id) === null),
  line(items, "public"));
edgeStatus = null;
// The domain connected to another bucket than the worker's (one made by hand under another name, the
// deploy making wiki): the site answers, / is R2's 404 and so is /status, while the bound bucket has
// built the page. Told from a missing rewrite rule by that, with no request more
emptyBucket = true;
({ items } = await run());
check("the domain on another bucket than the worker's (every path R2's 404 while the page is built): the public line passes, the rewrite line says the site doesn't serve this worker's bucket, from /status answering 404, with 2.2, to connect the domain to the bucket wrangler.toml names or bind the worker to the domain's bucket",
  ok(items, "public") === true && ok(items, "rewrite") === false && /doesn't serve this worker's bucket/.test(text(items, "rewrite")) && /\/status answers 404/.test(text(items, "rewrite")) && /bucket_name/.test(text(items, "rewrite")) && /Custom Domains/.test(text(items, "rewrite")) &&
  !/rewrite rule \/ → \/baked\.html is missing or wrong/.test(text(items, "rewrite")) && guide(items, "rewrite") === "2.2",
  `${line(items, "public")} | ${line(items, "rewrite")}`);
emptyBucket = false;

// --- 3. Backups, the queue, purges ------------------------------------------------------------------
// The repository's visibility, from the answer the check already gets: on this public wiki, said as
// information either way (a private wiki's case is in section 4)
api.private = false;
({ items } = await run());
check("a public backup repository on a public wiki: the backups line passes and says the repository is public, like the wiki",
  ok(items, "backups") === true && /a public repository, like the wiki/.test(text(items, "backups")), line(items, "backups"));
api.private = true;
({ items } = await run());
check("...a private one: said so", ok(items, "backups") === true && /a private repository/.test(text(items, "backups")), line(items, "backups"));
api.repo = 401;
({ items } = await run());
check("GitHub refusing the token (401): the backups line says so, with setup 2.4, and ends where the fix is: GitHub's token page, regenerate or make a new one (Contents: read and write, this repository only), then the GITHUB_TOKEN secret in the worker's Variables and Secrets", ok(items, "backups") === false && /401|token/.test(text(items, "backups")) && /Settings → Developer settings → Personal access tokens → Fine-grained tokens/.test(text(items, "backups")) && /regenerate it/.test(text(items, "backups")) && /Contents: read and write, this repository only/.test(text(items, "backups")) && /replace the GITHUB_TOKEN secret in the worker's Variables and Secrets/.test(text(items, "backups")) && guide(items, "backups") === "2.4", line(items, "backups"));
check("...the fix as its own todo field, the text ending at the diagnosis", /^On GitHub \(Settings → Developer settings/.test(todoOf(items, "backups")) && /the GITHUB_TOKEN secret is wrong or has expired\.$/.test(said(items, "backups")),
  `text ${JSON.stringify(said(items, "backups"))} | todo ${JSON.stringify(todoOf(items, "backups"))}`);
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
check("Cloudflare refusing the purge: the purges line says so, with the token's section, and ends with the hostname to purge once after the fix (Purge Cache → Custom Purge → Hostname, the public host, operating 3.9), since what changed while purges failed stays cached until its Edge TTL", ok(items, "purges") === false && /Authentication error|403/.test(text(items, "purges")) && guide(items, "purges") === "2.5" && new RegExp(`Then purge the public hostname once \\(Caching → Configuration → Purge Cache → Custom Purge → Hostname, ${PUBLIC_HOST.replace(/\./g, "\\.")}; operating 3\\.9\\): what changed while purges failed stays cached until its Edge TTL otherwise\\.$`).test(text(items, "purges")), line(items, "purges"));
check("...and the line ends with what to check: CF_ZONE_ID against the zone ID on the domain's overview page, the token under My Profile → API Tokens, a new one put in the CF_API_TOKEN secret",
  /Check CF_ZONE_ID against the zone ID on the domain's overview page/.test(text(items, "purges")) && /My Profile → API Tokens/.test(text(items, "purges")) && /put in the CF_API_TOKEN secret/.test(text(items, "purges")), line(items, "purges"));
check("...as its own todo field (the check, the new token, the hostname purge after), the text ending at what the token needs", /^Check CF_ZONE_ID against the zone ID/.test(todoOf(items, "purges")) && /Then purge the public hostname once/.test(todoOf(items, "purges")) && /CF_API_TOKEN needs Zone → Cache Purge on the zone CF_ZONE_ID names\.$/.test(said(items, "purges")),
  `text ${JSON.stringify(said(items, "purges"))} | todo ${JSON.stringify(todoOf(items, "purges"))}`);
api.purge = { status: 200, body: { success: true } };
api.purgeDown = true;
({ items } = await run());
check("Cloudflare's API not answering the purge at all: the line says so, with the error, and to check again in a moment, with setup 2.5",
  ok(items, "purges") === false && /didn't answer/.test(text(items, "purges")) && /again in a moment/.test(text(items, "purges")) && guide(items, "purges") === "2.5", line(items, "purges"));
api.purgeDown = false;
await site.setBindings({ GITHUB_REPO: "", GITHUB_TOKEN: "", CF_ZONE_ID: "", CF_API_TOKEN: "" });
({ items } = await run());
// Backups left out are a choice, like purges: a dash with the action, not a ✗ on a line that calls
// itself optional (design 2.20); half a pair stays a ✗, a mistake rather than a choice
check("backups not set up (neither setting): a dash, not a failure, the line saying backups are off and optional, with setup 2.4; no purge token: a dash, not a failure",
  ok(items, "backups") === null && guide(items, "backups") === "2.4" && /^Backups are off \(optional\): set GITHUB_REPO and the GITHUB_TOKEN secret to commit every save to GitHub, the wiki's only history/.test(text(items, "backups")) && ok(items, "purges") === null && /CF_ZONE_ID/.test(text(items, "purges")),
  `${line(items, "backups")} | ${line(items, "purges")}`);
check("...and the backups line ends with what to do: a repository and a fine-grained token with Contents read and write, then GITHUB_REPO (owner/repo) and the GITHUB_TOKEN secret in the worker's Variables and Secrets; backups said to be optional",
  /\(optional\)/.test(text(items, "backups")) && /fine-grained token limited to it, with Contents read and write/.test(text(items, "backups")) && /set GITHUB_REPO \(owner\/repo\) and the GITHUB_TOKEN secret in the worker's Variables and Secrets\.$/.test(text(items, "backups")), line(items, "backups"));
check("...and says what a wiki without backups lacks: a history, the bucket keeping the current version of each tiddler alone",
  /the wiki's only history/.test(text(items, "backups")) && /a deletion or an overwrite is final/.test(text(items, "backups")), line(items, "backups"));
check("...and the purges line ends with what to set: CF_ZONE_ID (the zone ID on the domain's overview page) and the CF_API_TOKEN secret (a token from My Profile → API Tokens with Zone → Cache Purge), in the worker's Variables and Secrets",
  /CF_ZONE_ID and CF_API_TOKEN aren't set/.test(text(items, "purges")) && /CF_ZONE_ID \(the zone ID on the domain's overview page\)/.test(text(items, "purges")) && /CF_API_TOKEN secret \(a token from My Profile → API Tokens with Zone → Cache Purge on that zone\) in the worker's Variables and Secrets\.$/.test(text(items, "purges")), line(items, "purges"));
check("(the queue is bound here)", ok(items, "queue") === true, line(items, "queue"));
// What the missing purge settings cost depends on the cache rules: with the page found cached, the
// rule keeps it for its Edge TTL, a day with the guide's setting, and the line says so instead of
// "optional"; with nothing cached, nothing holds a change back, and "optional" stays
cacheStatus = "DYNAMIC";
({ items } = await run());
check("...the page not cached (no cache rule): the purges line keeps calling the settings optional, no delay to name",
  ok(items, "purges") === null && /\(optional\)/.test(text(items, "purges")) && !/Edge TTL/.test(text(items, "purges")), line(items, "purges"));
cacheStatus = "HIT";
({ items } = await run());
check("...the page cached (the guide's cache rule in place): the purges line says what the missing settings cost, the rule keeping the page for its Edge TTL, a day with the guide's setting, so a change reaches the public site when that runs out; not called optional, still a dash",
  ok(items, "purges") === null && /"Cache public wiki"/.test(text(items, "purges")) && /Edge TTL/.test(text(items, "purges")) && /a day/.test(text(items, "purges")) && /when that runs out/.test(text(items, "purges")) && !/\(optional\)/.test(text(items, "purges")) && /CF_ZONE_ID \(the zone ID on the domain's overview page\)/.test(text(items, "purges")),
  line(items, "purges"));
await site.setBindings({ GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "", CF_ZONE_ID: "zone-1", CF_API_TOKEN: "" });
({ items } = await run());
check("the token missing of each pair, the other set: the backups line names GITHUB_TOKEN alone, with the repository, and says to make a token limited to it; the purges line names CF_API_TOKEN alone and says to set that secret",
  ok(items, "backups") === false && /has GITHUB_REPO \(someone\/wiki-backup\) but no GITHUB_TOKEN/.test(text(items, "backups")) && /Make a fine-grained token limited to that repository/.test(text(items, "backups")) && /put it in the GITHUB_TOKEN secret/.test(text(items, "backups")) &&
  ok(items, "purges") === null && /CF_API_TOKEN isn't set \(CF_ZONE_ID is\)/.test(text(items, "purges")) && /Set the CF_API_TOKEN secret, in the worker's Variables and Secrets/.test(text(items, "purges")) && !/overview page/.test(text(items, "purges")),
  `${line(items, "backups")} | ${line(items, "purges")}`);
await site.setBindings({ GITHUB_REPO: "", GITHUB_TOKEN: "ghp_test", CF_ZONE_ID: "", CF_API_TOKEN: "cf_test" });
({ items } = await run());
check("...the other way round: the backups line names GITHUB_REPO alone and says to set it to the repository the token is limited to; the purges line names CF_ZONE_ID alone and where its value is",
  ok(items, "backups") === false && /has GITHUB_TOKEN but no GITHUB_REPO/.test(text(items, "backups")) && /Set GITHUB_REPO, in the worker's Variables and Secrets/.test(text(items, "backups")) &&
  ok(items, "purges") === null && /CF_ZONE_ID isn't set \(CF_API_TOKEN is\)/.test(text(items, "purges")) && /Set CF_ZONE_ID, in the worker's Variables and Secrets, to the zone ID on the domain's overview page\.$/.test(text(items, "purges")),
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
const priv = await startSite({ index: readWikiFile(), publicStatus: true, privateWiki: true, outbound, bindings: { GITHUB_REPO: "someone/wiki-backup", GITHUB_TOKEN: "ghp_test" } });
await (await fetch(priv.base + "/")).arrayBuffer();
{
  const res = await fetch(priv.base + "/setup/check");
  const items = Object.fromEntries(((await res.json()).checks || []).map(c => [c.id, c]));
  // One line for the public site's five pieces and the purges, since none exists to check: five
  // dashes, one per piece, plus the purges' dash were noise before the lines that can fail (design 2.20)
  check("a private wiki: one line for the public site's pieces (no public site, so no rewrite, CORS or cache rules and no purges to check; setup 2.1), no per-piece lines and no purges line, Access fine",
    items.public && items.public.ok === null && /^No public site \(PUBLIC_WIKI_URL isn't set: a private wiki\), so no rewrite, CORS or cache rules and no purges to check\./.test(said(items, "public")) && guide(items, "public") === "2.1" && ["rewrite", "cors-reads", "cors-files", "cache", "purges"].every(id => !items[id]) && ok(items, "access") === true,
    ["public", "rewrite", "cors-reads", "cors-files", "cache", "purges"].map(id => `${id}: ${line(items, id)}`).join(" | "));
  // The worker can't see the bucket's domains: a custom domain, or the development URL, left on the
  // bucket serves the wiki whatever the setting says (operating 3.23), so the line says so in words,
  // with where to remove it, or the setting to set to the domain
  check("...and the line says a custom domain or the development URL left on the bucket still serves the wiki, with where to remove it (R2 → the bucket → Settings → Custom Domains), or PUBLIC_WIKI_URL to set to the domain",
    /custom domain still connected to the bucket, or its development URL \(r2\.dev\) left on, serves the wiki/.test(text(items, "public")) && /R2 → the bucket → Settings → Custom Domains/.test(text(items, "public")) && /set PUBLIC_WIKI_URL to the domain/.test(text(items, "public")),
    line(items, "public"));
  check("...the queue, not bound on this worker: its line says so, the deploy with the queue as its own todo", ok(items, "queue") === false && /^Deploy it with the queue wrangler\.toml names\.$/.test(todoOf(items, "queue")) && !/Deploy it/.test(said(items, "queue")),
    `${line(items, "queue")} | todo ${JSON.stringify(todoOf(items, "queue"))}`);
  // The backup repository's visibility matters here: a public one publishes every tiddler of a private
  // wiki, with its history, against what a private wiki promises (README, "Private, or public")
  const privCheck = async () => Object.fromEntries(((await (await fetch(priv.base + "/setup/check")).json()).checks || []).map(c => [c.id, c]));
  api.private = false;
  let again = await privCheck();
  check("a private wiki whose backup repository is public: the backups line fails, says anyone can read every tiddler there with its history, and ends with GitHub's place to change the visibility, with setup 2.4",
    ok(again, "backups") === false && /anyone can read every tiddler of this private wiki at https:\/\/github\.com\/someone\/wiki-backup, with its history/.test(text(again, "backups")) &&
    /Settings → Danger Zone → Change visibility/.test(text(again, "backups")) && guide(again, "backups") === "2.4", line(again, "backups"));
  api.private = true;
  again = await privCheck();
  check("...a private one passes, said so", ok(again, "backups") === true && /a private repository/.test(text(again, "backups")), line(again, "backups"));
}
await priv.close();

console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
process.exit(results.every(r => r.ok) ? 0 : 1);
