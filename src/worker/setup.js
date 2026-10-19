// The setup check (design 1.13): GET /setup/check, from the control panel's Cloudflare tab, looks at
// each piece of the setup that's done by hand and says what it found, a missing or wrong one naming
// the section of the setup guide that fixes it, with its link (docs.js). Nothing says these things
// otherwise: the page's own requests work without the CORS header, and a missing rewrite rule shows
// only to visitors. On demand only.
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

import { guide } from "./docs.js";
import { github, publicSite, publicUrl, purges } from "./settings.js";
import { CORE_KEY, LIST_KEY, PAGE_KEY, STATUS_KEY } from "./storage.js";

const SECTION = { private: "2.1", site: "2.2", queue: "2.3", backups: "2.4", worker: "2.5", access: "2.6", rules: "2.7" };
const PUBLIC_IDS = ["public", "rewrite", "cors-reads", "cors-files", "cache"];
// What Cloudflare's cache answered for a path a cache rule covers (DYNAMIC: none does)
const CACHED = ["HIT", "MISS", "EXPIRED", "STALE", "UPDATING", "REVALIDATED"];

export async function setupCheck(request, env, ctx, corsHeaders) {
  const origin = new URL(request.url).origin;
  const checks = [];
  const add = (id, ok, text, section) => checks.push({ id, ok, text, guide: guide("setup", section) });

  add("access", true, ctx.access
    ? "Cloudflare Access protects the admin site: this request came through it."
    : "Cloudflare Access is off for this local address (ACCESS = off, for tests and local runs only): a deployed worker refuses every request that didn't come through Access.", SECTION.access);

  const site = publicSite(env);
  if (site) {
    await checkPublicSite(env, site, origin, add);
  } else {
    for (const id of PUBLIC_IDS) add(id, null, "A private wiki, without a public site: nothing to check.", SECTION.private);
  }
  await checkBackups(env, add);
  add("queue", !!env.BACKUP_QUEUE, env.BACKUP_QUEUE
    ? "The backup queue is bound (BACKUP_QUEUE): saves are queued for backup, and a full backup can run."
    : "The backup queue isn't bound: the worker was deployed without BACKUP_QUEUE, so nothing can be queued for backup. Deploy it with the queue wrangler.toml names.", SECTION.queue);
  await checkPurges(env, site, add);

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
    return { status: res.status, etag: h("ETag"), lastModified: h("Last-Modified"), allowOrigin: h("Access-Control-Allow-Origin"), cache: h("CF-Cache-Status"), type: h("Content-Type"), res: keep ? res : null };
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

async function checkPublicSite(env, site, origin, add) {
  const [page, list, core, status, stored] = await Promise.all([
    probe(publicUrl(env, "/"), null, true),
    probe(publicUrl(env, "/" + LIST_KEY), origin),
    probe(publicUrl(env, "/" + CORE_KEY), origin),
    probe(publicUrl(env, "/" + STATUS_KEY), null),
    env.WIKI_BUCKET.head(PAGE_KEY)
  ]);
  // (A site that's down answers through Cloudflare's edge, a 5xx page, as often as not at all)
  if (page.error || page.status >= 500) {
    add("public", false, `The public site at ${site} didn't answer (${page.error || `answered ${page.status}`}): PUBLIC_WIKI_URL must be the bucket's custom domain, with its DNS record and the bucket's public access on.`, SECTION.site);
    for (const id of PUBLIC_IDS.slice(1)) add(id, null, "Not checked: the public site didn't answer.", SECTION.site);
    return;
  }
  add("public", true, `The public site answers at ${site}.`, SECTION.site);
  const which = await whichPage(page, stored);
  if (page.res && page.res.body && !page.res.bodyUsed) await page.res.body.cancel().catch(() => {});
  if (which === "current") {
    add("rewrite", true, "The public site's / serves the wiki page (the rewrite rule / → /baked.html).", SECTION.rules);
  } else if (which === "earlier") {
    add("rewrite", true, "The public site's / serves the wiki page (the rewrite rule / → /baked.html), an earlier build of it: Cloudflare's cached copy, purged at the next save, or when the cache rule's TTL runs out.", SECTION.rules);
  } else {
    const found = `answered ${page.status}, ${page.etag ? `ETag ${page.etag}` : "no ETag"}, ${page.lastModified ? `Last-Modified ${page.lastModified}` : "no Last-Modified"}`;
    const known = stored ? `the stored page's are "${bareEtag(stored.httpEtag)}" and ${stored.uploaded.toUTCString()}` : "the page isn't built yet";
    add("rewrite", false, `The public site's / doesn't serve the wiki page (${found}; ${known}): the rewrite rule / → /baked.html is missing or wrong.`, SECTION.rules);
  }
  const allowed = r => !r.error && (r.allowOrigin === origin || r.allowOrigin === "*");
  const found = r => r.error ? `no answer: ${r.error}` : r.allowOrigin ? `Access-Control-Allow-Origin: ${r.allowOrigin}` : "no Access-Control-Allow-Origin header";
  add("cors-reads", allowed(list),
    allowed(list) ? "The CORS rule lets the admin site read tiddlers from the public site (/recipes/)."
      : `The public site's tiddlers (/recipes/) can't be read from the admin site, ${origin} (${found(list)}): the transform rule is missing or doesn't cover /recipes/. Tiddlers load through the worker meanwhile, a request each.`, SECTION.rules);
  add("cors-files", allowed(core),
    allowed(core) ? "The CORS rule lets the admin site keep the core and plugin files for opening offline (/_plugins/)."
      : `The public site's core and plugin files (/_plugins/) can't be kept by the admin site, ${origin} (${found(core)}): the transform rule doesn't cover /_plugins/. The wiki runs online as before, and doesn't open offline on a device that doesn't have them.`, SECTION.rules);
  const cached = r => !r.error && CACHED.includes(String(r.cache || "").toUpperCase());
  const say = r => r.error ? "no answer" : r.cache || "no CF-Cache-Status header";
  const all = cached(page) && cached(core) && cached(status);
  add("cache", all ? true : null,
    `Cloudflare's cache answered for the page: ${say(page)}, the core file: ${say(core)}, the status file: ${say(status)}.` +
      (all ? "" : " DYNAMIC, or no header, means no cache rule covers it: the public site then goes to the bucket for it at every request (optional)."), SECTION.rules);
}

async function checkBackups(env, add) {
  const gh = github(env);
  if (!gh) {
    add("backups", false, "Backups aren't set up: the worker has no GITHUB_REPO and GITHUB_TOKEN. With them, every save is committed to GitHub.", SECTION.backups);
    return;
  }
  const headers = { Authorization: `Bearer ${gh.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "TiddlyWiki-Cloudflare-Worker" };
  const ask = async path => {
    try {
      const res = await fetch(`https://api.github.com/repos/${gh.repo}${path}`, { headers });
      let message = "";
      try { message = String((await res.json()).message || ""); } catch {}
      return { status: res.status, message };
    } catch (e) {
      return { status: 0, message: e && e.message ? e.message : String(e) };
    }
  };
  const repo = await ask("");
  if (repo.status === 401) {
    add("backups", false, `GitHub refuses the token for ${gh.repo} (401${repo.message ? `, ${repo.message}` : ""}): the GITHUB_TOKEN secret is wrong or has expired. Make a new one and put it in the secret.`, SECTION.backups);
  } else if (repo.status === 404) {
    add("backups", false, `GitHub doesn't find ${gh.repo} with this token (404): the repository doesn't exist under that name, or the token isn't allowed to see it.`, SECTION.backups);
  } else if (repo.status !== 200) {
    add("backups", false, `GitHub answered ${repo.status || "nothing"} for ${gh.repo}${repo.message ? ` (${repo.message})` : ""}.`, SECTION.backups);
  } else {
    const branch = await ask(`/branches/${encodeURIComponent(gh.branch)}`);
    if (branch.status === 200) {
      add("backups", true, `Backups go to ${gh.repo}, branch ${gh.branch}: GitHub accepts the token. (Whether it may write there shows at the first save; this tab reports backups that fail.)`, SECTION.backups);
    } else {
      add("backups", false, `GitHub finds ${gh.repo} but not its branch ${gh.branch} (${branch.status}${branch.message ? `, ${branch.message}` : ""}): GITHUB_BRANCH names a branch that doesn't exist, or the repository is empty.`, SECTION.backups);
    }
  }
}

async function checkPurges(env, site, add) {
  if (!site) {
    add("purges", null, "A private wiki: nothing to purge.", SECTION.private);
    return;
  }
  const zone = purges(env);
  if (!zone) {
    add("purges", null, "No purges: CF_ZONE_ID and CF_API_TOKEN aren't set, so a change shows on the public site when its cached copy expires (optional).", SECTION.worker);
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
      add("purges", false, `Cloudflare refused the purge (${res.status}${message ? `: ${message}` : ""}): CF_API_TOKEN needs Zone → Cache Purge on the zone CF_ZONE_ID names.`, SECTION.worker);
    }
  } catch (e) {
    add("purges", false, `Cloudflare's API didn't answer the purge (${e && e.message ? e.message : e}).`, SECTION.worker);
  }
}
