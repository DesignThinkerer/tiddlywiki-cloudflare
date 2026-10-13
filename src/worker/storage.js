// Everything the worker keeps in the bucket, by key (design 1.2 has the same table), and the small
// R2 helpers every module shares. The bucket is public through its custom domain: nothing private
// belongs in it.
//
// | key                                  | what                                              |
// |--------------------------------------|---------------------------------------------------|
// | index.html                           | the wiki engine: a TiddlyWiki with TiddlyWeb, never changed (page.js) |
// | baked.html                           | the page both sites serve, built by the worker (build.js) |
// | status                               | the public site's TiddlyWeb status (page.js)      |
// | recipes/default/tiddlers/<title>     | one JSON object per tiddler, in the flat layout (layout.js) |
// | recipes/default/tiddlers.json        | the tiddler list (list.js)                        |
// | _page/shell.html                     | the page published by the admin wiki (page.js)    |
// | _plugins/<title>.js                  | one file per plugin or module (plugins.js)        |
// | _plugins/tiddlywikicore.js           | TiddlyWiki's core file (page.js)                  |
// | manifest.webmanifest, _app/icon-*.png | the public site's manifest, and the app's icons (app.js) |
// | _repair/…                            | a damaged list, and a rebuild's progress (list.js) |
// | _backup/status.json                  | how backups go, and the last full backup (backup/status.js) |
// | _backup/versions/…                   | versions too big for a queue message (backup/queue.js) |

export const INDEX_KEY = "index.html";
export const PAGE_KEY = "baked.html";
export const STATUS_KEY = "status";
// Each tiddler is stored under its title
export const TIDDLER_PREFIX = "recipes/default/tiddlers/";
export const LIST_KEY = "recipes/default/tiddlers.json";
export const SHELL_KEY = "_page/shell.html";
export const PLUGIN_FILE_DIR = "_plugins/";
export const CORE_KEY = "_plugins/tiddlywikicore.js";
export const REPAIR_PROGRESS_KEY = "_repair/tiddler-list-progress.json";
export const BACKUP_STATUS_KEY = "_backup/status.json";

// A create-only write, with the same fallback as the save handler: if it's refused but nothing is
// there, it's written anyway. Returns the object written, or null if one was already there.
export async function putIfAbsent(env, key, value, options) {
  const written = await env.WIKI_BUCKET.put(key, value, { ...options, onlyIf: new Headers({ "If-None-Match": "*" }) });
  if (written || await env.WIKI_BUCKET.head(key)) return written;
  return env.WIKI_BUCKET.put(key, value, options);
}

// Calls fn on each item, at most `limit` at a time (a request has 6 connections)
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// The page is built again on the next page load, rather than in this request: it may have been built
// from a list that missed a plugin (a save whose list update failed and was never retried), or a
// build after a change failed
export async function markPageOutdated(env) {
  const page = await env.WIKI_BUCKET.get(PAGE_KEY);
  if (!page) return;
  await env.WIKI_BUCKET.put(PAGE_KEY, await page.arrayBuffer(), {
    httpMetadata: page.httpMetadata,
    customMetadata: { ...page.customMetadata, bakeVersion: "outdated" },
    onlyIf: { etagMatches: page.etag }
  });
}
