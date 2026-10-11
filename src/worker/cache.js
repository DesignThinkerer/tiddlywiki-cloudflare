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
