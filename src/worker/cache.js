// The public site's cache: the public wiki is served straight from the R2 bucket through
// Cloudflare's cache, so after a change the worker purges exactly the public URLs that serve it
// (single-file purge, not purge_everything; design 1.6). A private wiki has no public site, so
// nothing to purge.

import { publicSite, publicUrl, purges } from "./settings.js";

// The query string is part of the cache key, so the tiddler list is purged under each URL
// TiddlyWiki requests it with: the TiddlyWiki 5.4 filter, the filter of earlier versions, and bare.
const SKINNY_LIST_FILTERS = [
  "[all[tiddlers]] -[[$:/isEncrypted]] -[prefix[$:/temp/]] -[prefix[$:/status/]] -[[$:/boot/boot.js]] -[[$:/boot/bootprefix.js]] -[has[plugin-type]field:platform[server]] -[[$:/library/sjcl.js]] -[[$:/core]]",
  "[all[tiddlers]] -[[$:/isEncrypted]] -[prefix[$:/temp/]] -[prefix[$:/status/]] -[[$:/boot/boot.js]] -[[$:/boot/bootprefix.js]] -[[$:/library/sjcl.js]] -[[$:/core]]"
];

// URLs that serve the wiki page itself
export const PUBLIC_PAGE_PATHS = ["/", "/baked.html"];

// Encoded the same way TiddlyWiki encodes them when it requests them. The admin page reads tiddlers
// from the public site too, cross-origin: its requests carry an Origin header, which Cloudflare
// keeps in the cache key, so its copy is a separate cache entry, purged with that header.
export function tiddlerPurgeUrls(env, title, adminOrigin) {
  const url = publicUrl(env, `/recipes/default/tiddlers/${encodeURIComponent(title)}`);
  return [url, { url, headers: { Origin: adminOrigin } }, ...listPurgeUrls(env)];
}

export function listPurgeUrls(env) {
  return [
    publicUrl(env, "/recipes/default/tiddlers.json"),
    ...SKINNY_LIST_FILTERS.map(filter => publicUrl(env, `/recipes/default/tiddlers.json?filter=${encodeURIComponent(filter)}`))
  ];
}

// POST /purge from the admin wiki's Cloudflare tab (design 2.10's one exception: a hostname purge on a
// click, one call with the token the worker holds, never purge_everything, which clears every site in
// the zone; no R2 operation). Only with the modules' header, since anything in the wiki can call the
// admin origin (2.23, 2.31); refused without the purge settings, with the check's words for what to set
export async function purgeHostname(request, env, corsHeaders) {
  const headers = { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" };
  if (request.headers.get("X-Requested-With") !== "TiddlyWiki") return new Response("The public site's cache is purged from the admin wiki's Cloudflare tab.", { status: 403, headers });
  const site = publicSite(env), zone = purges(env);
  if (!site) return new Response("No public site: nothing to purge (a private wiki).", { status: 400, headers });
  if (!zone) return new Response("No purge settings: set CF_ZONE_ID (the zone ID on the domain's overview page) and the CF_API_TOKEN secret (a token from My Profile → API Tokens with Zone → Cache Purge on that zone) in the worker's Variables and Secrets, as Check the setup says.", { status: 400, headers });
  const host = new URL(site).host;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone.zoneId}/purge_cache`, {
      method: "POST", headers: { "Authorization": `Bearer ${zone.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hosts: [host] })
    });
    let body = null;
    try { body = await res.json(); } catch {}
    if (res.ok && body && body.success) return new Response(`Purged ${host} from Cloudflare's cache: every page and file of the public site is fetched afresh at its next request.`, { status: 200, headers });
    const message = body && Array.isArray(body.errors) && body.errors.length ? body.errors.map(e => e.message).join("; ") : "";
    return new Response(`Cloudflare refused the purge (${res.status}${message ? `: ${message}` : ""}): Check the setup tests the token and says what to replace.`, { status: 502, headers });
  } catch (e) {
    return new Response(`Cloudflare's API didn't answer (${e && e.message ? e.message : e}): try again in a moment.`, { status: 502, headers });
  }
}

export async function purgePublicCache(env, urls) {
  const zone = purges(env);
  if (!zone || !publicSite(env) || urls.length === 0) return;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone.zoneId}/purge_cache`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${zone.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ files: urls })
    });
    if (!res.ok) console.error(`Cache purge failed (${res.status}):`, await res.text());
  } catch (e) {
    console.error("Cache purge exception:", e.message);
  }
}
