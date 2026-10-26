// The setup check (design 1.13): GET /setup/check, from the control panel's Cloudflare tab, looks at
// each piece of the setup that's done by hand and says what it found, a missing or wrong one naming
// the section of the setup guide that fixes it, with its link (docs.js). Nothing says these things
// otherwise: the page's own requests work without the CORS header, and a missing rewrite rule shows
// only to visitors. On demand only. A line that finds a piece missing or wrong ends with the one
// thing to do (the dashboard's place, the setting, the rule), before the guide's section with the
// full steps: the manual is a click away, the next step shouldn't be (design 2.20).
//
// From here: Access (this request came through it); the public site as the worker sees it from its
// own requests — the page at / (the rewrite rule, checked by ETag against the stored page: one R2
// head, no body read), the tiddler list and the core file asked for with the admin site as Origin
// (the CORS rule, each of its two paths), the status file, and what Cloudflare's cache answered for
// each (the cache rules, optional); backups (GitHub asked for the repository and its branch with
// the token) and the queue binding; purges (one purge, of the status file's cached copy: a token
// allowed only to purge can't be tested another way). The browser adds its own lines (the service
// worker, the core file kept) in the tab, $:/cfworker/control-panel.js.
//
// Each line: { id, ok: true | false | null (nothing to check, or optional), text, guide: { section,
// text ("setup 2.6"), url } }.

import { accessIdentity } from "./access.js";
import { guide } from "./docs.js";
import { github, publicSite, publicUrl, purges } from "./settings.js";
import { CORE_KEY, LIST_KEY, PAGE_KEY, STATUS_KEY } from "./storage.js";

const SECTION = { private: "2.1", site: "2.2", queue: "2.3", backups: "2.4", worker: "2.5", access: "2.6", rules: "2.7" };
const PUBLIC_IDS = ["public", "rewrite", "cors-reads", "cors-files", "cache"];
// The public site's five pieces by name, one line per piece as on a public wiki, each naming the piece
// it stands for, when the site doesn't answer (not checked): one sentence five times read as a loop
// gone wrong
const PIECE = { "public": "The public site", "rewrite": "The rewrite rule", "cors-reads": "The CORS rule, tiddler reads", "cors-files": "The CORS rule, files", "cache": "The cache rules" };
// A private wiki: one line for the public site's five pieces and the purges, since none exists to check
// (five dashes, one per piece, plus the purges' dash were noise before the lines that can fail: design
// 2.20); it adds that a custom domain, or the development URL, left on the bucket serves the wiki
// whatever the setting says, in words: the worker can't see the bucket's domains (operating 3.23, 2.15)
const PRIVATE_LINE = "No public site (PUBLIC_WIKI_URL isn't set: a private wiki), so no rewrite, CORS or cache rules and no purges to check. A custom domain still connected to the bucket, or its development URL (r2.dev) left on, serves the wiki all the same, and the worker can't see them: remove it (R2 → the bucket → Settings → Custom Domains, Public Development URL; operating 3.23), or set PUBLIC_WIKI_URL to the domain to make the wiki public (operating 3.22).";
const uncheckedLine = id => `${PIECE[id]}: not checked, the public site didn't answer.`;
// Where the worker's settings are set, in every line that names one
const VARS = "in the worker's Variables and Secrets";
// GitHub's page for a fine-grained token: its permissions and the repositories it may see
const TOKENS = "Settings → Developer settings → Personal access tokens → Fine-grained tokens";
// What a wiki without backups lacks, said wherever they're called optional (the Cloudflare tab says the same)
const HISTORY = "the wiki's only history: the bucket keeps the current version of each tiddler alone, and a deletion or an overwrite is final";
// What Cloudflare's cache answered for a path a cache rule covers (DYNAMIC: none does)
const CACHED = ["HIT", "MISS", "EXPIRED", "STALE", "UPDATING", "REVALIDATED"];

export async function setupCheck(request, env, ctx, corsHeaders) {
  const origin = new URL(request.url).origin;
  const checks = [];
  // todo: the one thing to do, its own field beside the text, which the tab shows on its own line under
  // what was found (design 2.20); a passing line has none, a dash's is optional
  const add = (id, ok, text, section, todo) => checks.push({ id, ok, text, guide: guide("setup", section), ...(todo ? { todo } : {}) });

  // (Whom Access let in is said; the policy itself can't be read without an account-level token,
  // which the worker mustn't hold: design 2.20)
  const who = ctx.access ? await accessIdentity(request, ctx) : null;
  add("access", true, ctx.access
    ? `Cloudflare Access protects the admin site: this request came through it${who ? `, logged in as ${who}` : ""}. The policy itself isn't checked: under Workers & Pages → the worker → the Access tab (or Zero Trust → Access → Applications → the application), it should allow you alone.`
    : "Cloudflare Access is off for this local address (ACCESS = off, for tests and local runs only): a deployed worker refuses every request that didn't come through Access.", SECTION.access);

  const site = publicSite(env);
  let pageCached = false;   // the public site's page found cached: what missing purge settings cost (checkPurges)
  if (site) {
    pageCached = await checkPublicSite(env, site, origin, add);
  } else {
    add("public", null, PRIVATE_LINE, SECTION.private);
  }
  await checkBackups(env, site, add);
  add("queue", !!env.BACKUP_QUEUE, env.BACKUP_QUEUE
    ? "The backup queue is in place (BACKUP_QUEUE)."
    : "The backup queue isn't bound: the worker was deployed without BACKUP_QUEUE, so nothing can be queued for backup.", SECTION.queue,
    env.BACKUP_QUEUE ? null : "Deploy it with the queue wrangler.toml names.");
  await checkPurges(env, site, add, pageCached);

  return new Response(JSON.stringify({ checked: new Date().toISOString(), checks }), {
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

// One request to the public site, with the admin site as Origin when asked: what came back, by
// its headers. The body is dropped unread, unless the caller keeps it (keep) to read it itself.
async function probe(url, origin, keep) {
  try {
    const res = await fetch(url, { headers: origin ? { Origin: origin } : {}, redirect: "follow" });
    const h = name => res.headers.get(name);
    if (!keep && res.body) await res.body.cancel();
    return { status: res.status, etag: h("ETag"), lastModified: h("Last-Modified"), allowOrigin: h("Access-Control-Allow-Origin"), cache: h("CF-Cache-Status"), cacheControl: h("Cache-Control"), type: h("Content-Type"), res: keep ? res : null };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

const bareEtag = etag => (etag || "").replace(/^W\//, "").replace(/^"|"$/g, "");
const seconds = date => Math.floor((date instanceof Date ? date.getTime() : Date.parse(date || "")) / 1000);
// What every page the worker builds carries: its own tiddlers (build.js)
const PAGE_MARK = "$:/cfworker/";

// What the public site's / is: the stored page ("current"), known by ETag when the answer has one
// (bare of W/ and quotes: Cloudflare's compression weakens it), else by date (Last-Modified against
// the object's upload time: Cloudflare removes an HTML answer's ETag when a feature of the zone
// rewrites the page, Email Address Obfuscation say, on by default, but keeps the date); failing
// those, by the page's own mark in the body, read only then: with neither header, the page
// ("current", nothing says otherwise), and with a header that doesn't match, an earlier build of it
// ("earlier": Cloudflare's cached copy, the page rebuilt since, purged at the next save or expiring
// with the cache rule's TTL), which is the wiki page too, so the rule is in place; or not the page
// at all (false)
async function whichPage(page, stored) {
  if (page.status !== 200 || !stored) return false;
  const headed = !!(page.etag || page.lastModified);
  if (page.etag && bareEtag(page.etag) === bareEtag(stored.httpEtag)) return "current";
  if (!page.etag && page.lastModified && seconds(page.lastModified) === seconds(stored.uploaded)) return "current";
  try {
    return (await page.res.text()).includes(PAGE_MARK) ? (headed ? "earlier" : "current") : false;
  } catch {
    return false;
  }
}

// Returns whether the page was found cached (the cache rule in place: what missing purge settings
// cost, checkPurges)
async function checkPublicSite(env, site, origin, add) {
  const host = new URL(site).host;   // (PUBLIC_WIKI_URL is checked before any request is handled: a URL)
  const [page, list, core, status, stored] = await Promise.all([
    probe(publicUrl(env, "/"), null, true),
    probe(publicUrl(env, "/" + LIST_KEY), origin),
    probe(publicUrl(env, "/" + CORE_KEY), origin),
    probe(publicUrl(env, "/" + STATUS_KEY), null),
    env.WIKI_BUCKET.head(PAGE_KEY)
  ]);
  // (A site that's down answers through Cloudflare's edge, a 5xx page, as often as not at all: a 530
  // for the minutes a custom domain takes to initialise, the commonest first check. Said apart from
  // no answer, with the wait, rather than "didn't answer (answered 530)" and the domain to connect)
  if (page.error || page.status >= 500) {
    const found = page.error ? `didn't answer (${page.error}): nothing answers at PUBLIC_WIKI_URL` : `answered ${page.status}: Cloudflare's edge, with no bucket behind the host yet`;
    add("public", false, `The public site at ${site} ${found}.`, SECTION.site,
      `If you connected the domain to the bucket in the last few minutes, Cloudflare is still setting it up: check the setup again in a few minutes. Otherwise connect the domain to the bucket (R2 → the bucket → Settings → Custom Domains, which creates its DNS record and turns public access on for it), or correct PUBLIC_WIKI_URL, ${VARS}, now "${site}", to https:// and that domain, nothing after the hostname.`);
    for (const id of PUBLIC_IDS.slice(1)) add(id, null, uncheckedLine(id), SECTION.site);
    return false;
  }
  add("public", true, `The public site answers at ${site}.`, SECTION.site);
  const which = await whichPage(page, stored);
  if (page.res && page.res.body && !page.res.bodyUsed) await page.res.body.cancel().catch(() => {});
  if (which === "current") {
    add("rewrite", true, "The public site's / serves the wiki page (the rewrite rule / → /baked.html).", SECTION.rules);
  } else if (which === "earlier") {
    add("rewrite", true, "The public site's / serves the wiki page (the rewrite rule / → /baked.html), an earlier build of it: Cloudflare's cached copy, purged at the next save, or when the cache rule's TTL runs out.", SECTION.rules);
  } else if (stored && !status.error && status.status === 404) {
    // (The status file is a plain object no rule touches, written with the page at the first visit:
    // 404 there while the bound bucket has built the page means the domain is on another bucket)
    add("rewrite", false, `The public site at ${host} doesn't serve this worker's bucket: its /status answers 404 while the bucket bound as WIKI_BUCKET has built the page, so the domain is connected to another bucket (one made by hand under another name, say, the deploy having made the one wrangler.toml names).`, SECTION.site,
      `Connect the domain to the worker's bucket (R2 → the bucket bucket_name names in wrangler.toml → Settings → Custom Domains, after removing it from the other), or set bucket_name in wrangler.toml to the bucket the domain is on and deploy again.`);
  } else {
    const found = `answered ${page.status}, ${page.etag ? `ETag ${page.etag}` : "no ETag"}, ${page.lastModified ? `Last-Modified ${page.lastModified}` : "no Last-Modified"}`;
    const known = stored ? `the stored page's are "${bareEtag(stored.httpEtag)}" and ${stored.uploaded.toUTCString()}` : "the page isn't built yet";
    add("rewrite", false, `The public site's / doesn't serve the wiki page: the rewrite rule / → /baked.html is missing or wrong (${found}; ${known}).`, SECTION.rules,
      `Add it under the domain, Rules → Transform Rules → Rewrite URL: when the host is ${host} and the path is /, rewrite the path to /baked.html.`);
  }
  const allowed = r => !r.error && (r.allowOrigin === origin || r.allowOrigin === "*");
  const found = r => r.error ? `no answer: ${r.error}` : r.allowOrigin ? `Access-Control-Allow-Origin: ${r.allowOrigin}` : "no Access-Control-Allow-Origin header";
  // A header present with another value (a trailing slash, http, the public hostname): the rule is
  // there and its value is wrong, so it's the value to fix, not a path to add
  const wrongValue = r => !r.error && !!r.allowOrigin && !allowed(r);
  const valueToFix = r => `the CORS rule sets Access-Control-Allow-Origin to ${r.allowOrigin}, and it must be exactly ${origin} (https, the admin site's address, nothing after the hostname)`;
  const fixValue = "Fix the header's value under the domain, Rules → Transform Rules → Modify Response Header.";
  const addRule = `Add or fix the rule under the domain, Rules → Transform Rules → Modify Response Header: when the host is ${host} and the path starts with /recipes/ or /_plugins/, set Access-Control-Allow-Origin to ${origin}.`;
  add("cors-reads", allowed(list),
    allowed(list) ? "The CORS rule lets the admin site read tiddlers from the public site (/recipes/)."
      : wrongValue(list) ? `The public site's tiddlers (/recipes/) can't be read from the admin site, ${origin}: ${valueToFix(list)}; tiddlers load through the worker meanwhile, a request each.`
      : `The public site's tiddlers (/recipes/) can't be read from the admin site, ${origin} (${found(list)}): the CORS rule is missing or doesn't cover /recipes/; tiddlers load through the worker meanwhile, a request each.`, SECTION.rules,
    allowed(list) ? null : wrongValue(list) ? fixValue : addRule);
  add("cors-files", allowed(core),
    allowed(core) ? "The CORS rule lets the admin site keep the core and plugin files for opening offline (/_plugins/)."
      : wrongValue(core) ? `The public site's core and plugin files (/_plugins/) can't be kept by the admin site, ${origin}: ${valueToFix(core)}; the wiki runs online as before, and doesn't open offline on a device that doesn't have them.`
      : `The public site's core and plugin files (/_plugins/) can't be kept by the admin site, ${origin} (${found(core)}): the CORS rule doesn't cover /_plugins/; the wiki runs online as before, and doesn't open offline on a device that doesn't have them.`, SECTION.rules,
    allowed(core) ? null : wrongValue(core) ? fixValue : `Add the path to the rule's When, under the domain's Rules → Transform Rules → Modify Response Header: the host is ${host} and the path starts with /recipes/ or /_plugins/.`);
  const cached = r => !r.error && CACHED.includes(String(r.cache || "").toUpperCase());
  const say = r => r.error ? "no answer" : r.cache || "no CF-Cache-Status header";
  const all = cached(page) && cached(core) && cached(status);
  // The setup guide's rule for each path, named when the path isn't cached (2.7: the second and
  // third are placed after the first, which covers the whole host)
  const rules = [!cached(page) && '"Cache public wiki" for the page', !cached(core) && '"Cache plugin files" for the core and plugin files', !cached(status) && '"Cache status file" for the status file'].filter(Boolean);
  const ttl = cached(page) ? browserTtl(page) : { text: "", todo: "" };
  add("cache", all ? true : null,
    `Cloudflare's cache answered for the page: ${say(page)}, the core file: ${say(core)}, the status file: ${say(status)}.` +
      (all ? "" : " DYNAMIC, or no header, means no cache rule covers it, and the public site goes to the bucket for it at every request.") +
      ttl.text, SECTION.rules,
    [all ? "" : `To cache it (optional), add under the domain's Rules → Cache Rules: ${rules.join(", ")}.`, ttl.todo].filter(Boolean).join(" ") || null);
  return cached(page);
}

// The page's Browser TTL, from the cache answer's Cache-Control (no request added): the one field of
// the cache rule whose mistake is invisible at setup and felt daily. Long (over 15 minutes), or
// missing (Cloudflare's default of four hours), said with why it matters and where to set it, as
// information (the mark doesn't change, design 2.20); short, the value is named. The setting to make
// is the line's todo
const BROWSER_TTL_LONG = 15 * 60;
const BROWSER_TTL_TODO = `In the "Cache public wiki" rule, set Browser TTL to Override, 5 minutes.`;
function browserTtl(page) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(page.cacheControl || "");
  if (!match) return { text: ` The page has no Browser TTL (no Cache-Control header), so Cloudflare's default of 4 hours applies: a visitor's browser, your own included, keeps a page that long after an edit, and purges don't reach it.`, todo: BROWSER_TTL_TODO };
  const seconds = Number(match[1]);
  const said = seconds % 3600 === 0 && seconds >= 3600 ? `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}` : seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`;
  if (seconds <= BROWSER_TTL_LONG) return { text: ` The page's Browser TTL is ${said} (Cache-Control: ${page.cacheControl.trim()}).`, todo: "" };
  return { text: ` The page's Browser TTL is ${said} (Cache-Control: ${page.cacheControl.trim()}): a visitor's browser, your own included, keeps a page that long after an edit, and purges don't reach it.`, todo: BROWSER_TTL_TODO };
}

// site: the public site's address, "" for a private wiki, whose backup repository must be private too
async function checkBackups(env, site, add) {
  const gh = github(env);
  if (!gh) {
    const has = env.GITHUB_REPO ? `GITHUB_REPO (${env.GITHUB_REPO}) but no GITHUB_TOKEN` : env.GITHUB_TOKEN ? "GITHUB_TOKEN but no GITHUB_REPO" : "no GITHUB_REPO and no GITHUB_TOKEN";
    const todo = env.GITHUB_REPO ? `Make a fine-grained token limited to that repository, with Contents read and write, and put it in the GITHUB_TOKEN secret, ${VARS}.`
      : env.GITHUB_TOKEN ? `Set GITHUB_REPO, ${VARS}, to the backup repository's owner/repo, the one the token is limited to.`
        : `Create a repository for the backup and a fine-grained token limited to it, with Contents read and write, then set GITHUB_REPO (owner/repo) and the GITHUB_TOKEN secret ${VARS}.`;
    // Neither setting: backups left out, a choice like purges, a dash with the action (design 2.20);
    // one of the pair: a mistake, a failure naming the missing one
    if (!env.GITHUB_REPO && !env.GITHUB_TOKEN) {
      add("backups", null, `Backups are off (optional): set GITHUB_REPO and the GITHUB_TOKEN secret to commit every save to GitHub, ${HISTORY}.`, SECTION.backups, todo);
      return;
    }
    add("backups", false, `Backups aren't set up: the worker has ${has} (optional; with it, every save is committed to GitHub, ${HISTORY}).`, SECTION.backups, todo);
    return;
  }
  const headers = { Authorization: `Bearer ${gh.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "TiddlyWiki-Cloudflare-Worker" };
  // What came back: the status, GitHub's message, and for the repository its visibility (public: true or
  // false; null when the answer doesn't say). GitHub's "visibility" first: "internal", on an enterprise
  // plan, isn't public though "private" reads false there; "private" when the field is missing (design 2.35)
  const ask = async path => {
    try {
      const res = await fetch(`https://api.github.com/repos/${gh.repo}${path}`, { headers });
      let message = "", body = null;
      try { body = await res.json(); message = String(body.message || ""); } catch {}
      const isPublic = body && typeof body.visibility === "string" ? body.visibility === "public" : body && typeof body.private === "boolean" ? !body.private : null;
      return { status: res.status, message, isPublic };
    } catch (e) {
      return { status: 0, message: e && e.message ? e.message : String(e), isPublic: null };
    }
  };
  const repo = await ask("");
  if (repo.status === 401) {
    add("backups", false, `GitHub refuses the token for ${gh.repo} (401${repo.message ? `, ${repo.message}` : ""}): the GITHUB_TOKEN secret is wrong or has expired.`, SECTION.backups,
      `On GitHub (${TOKENS}), regenerate it (it keeps its repository and permission) or make a new one as in setup 2.4 (Contents: read and write, this repository only; the guide's link opens GitHub's form filled in), then replace the GITHUB_TOKEN secret ${VARS}.`);
  } else if (repo.status === 404) {
    add("backups", false, `GitHub doesn't find ${gh.repo} with this token (404): the repository doesn't exist under that name, or the token isn't allowed to see it.`, SECTION.backups,
      `Check GITHUB_REPO (owner/repo, as in the repository's address), then the token's Repository access on GitHub (${TOKENS}): it must name that repository.`);
  } else if (repo.status !== 200) {
    add("backups", false, `GitHub answered ${repo.status || "nothing"} for ${gh.repo}${repo.message ? ` (${repo.message})` : ""}.`, SECTION.backups,
      `Check the setup again in a moment: a rate limit, or no answer, passes by itself; an answer that stays is GitHub's reason, and the token's permissions (Contents: read and write) and Repository access, on GitHub under ${TOKENS}, are where to look.`);
  } else {
    const branch = await ask(`/branches/${encodeURIComponent(gh.branch)}`);
    if (branch.status === 200 && repo.isPublic && !site) {
      // A private wiki's backup in a public repository: every save readable by anyone, with its history,
      // against what a private wiki promises (README, "Private, or public"). Failed, with GitHub's place to
      // change it; on a public wiki (below) the visibility is said and nothing fails (design 2.35)
      add("backups", false, `Backups go to ${gh.repo}, branch ${gh.branch}, and the repository is public: anyone can read every tiddler of this private wiki at https://github.com/${gh.repo}, with its history.`, SECTION.backups,
        `Make it private on GitHub (the repository's Settings → Danger Zone → Change visibility), or move the backup to a private repository, with a token limited to it.`);
    } else if (branch.status === 200) {
      const visibility = repo.isPublic === null ? "" : repo.isPublic ? ", a public repository, like the wiki" : ", a private repository";
      add("backups", true, `Backups go to ${gh.repo}, branch ${gh.branch}${visibility}: GitHub accepts the token. (Whether it may write there shows at the first save; the tab's Backups section and an alert report backups that fail.)`, SECTION.backups);
    } else {
      add("backups", false, `GitHub finds ${gh.repo} but not its branch ${gh.branch} (${branch.status}${branch.message ? `, ${branch.message}` : ""}): the repository has no such branch, or is empty.`, SECTION.backups,
        `Set GITHUB_BRANCH, ${VARS}, to a branch it has (main when GITHUB_BRANCH isn't set), or give an empty repository its first commit (a README added on GitHub does).`);
    }
  }
}

// pageCached: the public site's page found cached (checkPublicSite). Without the purge settings the
// line is a dash either way (the site works: the rules are optional, setup 2.7), but what they cost
// differs: with the page cached, the rule keeps it for its Edge TTL, a day with the guide's setting,
// and the line says so in those numbers rather than "optional"; with nothing cached, nothing holds a
// change back (design 2.20)
async function checkPurges(env, site, add, pageCached) {
  if (!site) return;   // (a private wiki: the one line for the public site's pieces says there are no purges to check)
  const zone = purges(env);
  if (!zone) {
    const missing = env.CF_ZONE_ID ? "CF_API_TOKEN isn't set (CF_ZONE_ID is)" : env.CF_API_TOKEN ? "CF_ZONE_ID isn't set (CF_API_TOKEN is)" : "CF_ZONE_ID and CF_API_TOKEN aren't set";
    const todo = env.CF_ZONE_ID ? `Set the CF_API_TOKEN secret, ${VARS}: a token from My Profile → API Tokens with Zone → Cache Purge on that zone.`
      : env.CF_API_TOKEN ? `Set CF_ZONE_ID, ${VARS}, to the zone ID on the domain's overview page.`
        : `Set CF_ZONE_ID (the zone ID on the domain's overview page) and the CF_API_TOKEN secret (a token from My Profile → API Tokens with Zone → Cache Purge on that zone) ${VARS}.`;
    const cost = pageCached
      ? `and the cache rule "Cache public wiki" (setup 2.7) keeps the page for its Edge TTL, a day with the guide's setting, so a change made in the admin wiki reaches the public site when that runs out; with purges, at once.`
      : `so a change shows on the public site when its cached copy expires (optional).`;
    add("purges", null, `No purges: ${missing}, ${cost}`, SECTION.worker, todo);
    return;
  }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone.zoneId}/purge_cache`, {
      method: "POST", headers: { Authorization: `Bearer ${zone.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files: [publicUrl(env, "/" + STATUS_KEY)] })
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.ok && body && body.success) {
      add("purges", true, "Purges work: the public site's status file was purged from Cloudflare's cache to check (CF_ZONE_ID, CF_API_TOKEN).", SECTION.worker);
    } else {
      const message = body && Array.isArray(body.errors) && body.errors.length ? body.errors.map(e => e.message).join("; ") : "";
      add("purges", false, `Cloudflare refused the purge (${res.status}${message ? `: ${message}` : ""}): CF_API_TOKEN needs Zone → Cache Purge on the zone CF_ZONE_ID names.`, SECTION.worker,
        `Check CF_ZONE_ID against the zone ID on the domain's overview page, and the token under My Profile → API Tokens (its permissions, its zone, whether it has expired or was revoked); a new token there, put in the CF_API_TOKEN secret, replaces it. Then purge the public hostname once (Caching → Configuration → Purge Cache → Custom Purge → Hostname, ${new URL(site).host}; operating 3.9): what changed while purges failed stays cached until its Edge TTL otherwise.`);
    }
  } catch (e) {
    add("purges", false, `Cloudflare's API didn't answer the purge (${e && e.message ? e.message : e}): the request to api.cloudflare.com failed before any answer.`, SECTION.worker,
      "Check the setup again in a moment; if it keeps failing, see cloudflarestatus.com.");
  }
}
