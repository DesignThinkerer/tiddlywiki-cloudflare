// The reads: the TiddlyWeb status, the tiddler list, and any object of the bucket by its key (a
// tiddler, a file). README 4.1.

import { backupReport, readBackupStatus } from "./backup/status.js";
import { objectHeaders, parseEtagList, untilDone } from "./http.js";
import { parseList, rebuildList, rebuildingResponse } from "./list.js";
import { MANIFEST_KEY } from "./storage.js";

// What /status answers on the admin site: TiddlyWeb's status. TiddlyWiki asks for it at every page
// load, before the tiddler list. It never changes, so the browser keeps it for a week (private: for
// that browser only): the next loads don't ask the worker, nor wait for its answer. (The public site
// has its own file, README 3.1.)
export const ADMIN_STATUS = { username: "admin", read_only: false, anonymous: false, logout_is_available: true, space: { recipe: "default" } };

export const STATUS_CACHE = "private, max-age=604800";

// Serves the tiddler list, answering 304 when the browser already has the current version
export async function serveManifest(request, env, ctx, corsHeaders) {
  // Our ETag is "<R2 etag>-patched"; Cloudflare's compression may hand it back weakened as W/"..."
  const known = parseEtagList(request.headers.get("If-None-Match")).find(token => token.endsWith("-patched"));
  // The admin wiki asks how backups go with this request (README 4.7): read at the same time
  const [listObject, backups] = await Promise.all([
    env.WIKI_BUCKET.get(MANIFEST_KEY, known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -"-patched".length) } } : undefined),
    request.headers.get("X-Backup-Status") === "ask" ? readBackupStatus(env) : null
  ]);
  let object = listObject;
  const listHeaders = obj => {
    const headers = listResponseHeaders(obj, corsHeaders);
    if (backups) headers.set("X-Backup-Status", backupReport(env, backups.failing));
    return headers;
  };
  // A conditional get that fails its precondition returns the object without a body
  if (object && !("body" in object)) return new Response(null, { status: 304, headers: listHeaders(object) });

  let text = object ? await object.text() : null;
  let manifest = text === null ? null : parseList(text);
  // Every entry the worker writes has its bag and recipe: then the list is served as stored, not
  // written out again (which costs about as much CPU as reading it)
  if (manifest && manifest.every(t => t.bag && t.recipe)) return new Response(text, { headers: listHeaders(object) });
  if (!manifest) {
    // Missing or damaged: rebuilt from the stored tiddlers. (Answering [] would make every open tab
    // remove all its tiddlers as "missing from the server".)
    const rebuilt = await untilDone(ctx, rebuildList(env, ctx, { object, text }));
    // Just rebuilt: served as written (every entry already has its bag and recipe)
    if (rebuilt?.fresh) return new Response(rebuilt.text, { headers: listHeaders(rebuilt.object) });
    manifest = rebuilt?.entries;
    if (!manifest) return rebuildingResponse(corsHeaders);
    object = rebuilt.object;
  }
  // Written by hand, say
  manifest = manifest.map(t => ({ ...t, bag: t.bag || "default", recipe: t.recipe || "default" }));
  return new Response(JSON.stringify(manifest), { headers: listHeaders(object) });
}

function listResponseHeaders(object, corsHeaders) {
  const headers = objectHeaders(object, corsHeaders);
  headers.set("Cache-Control", "no-cache");
  headers.set("ETag", `"${object.etag}-patched"`);
  return headers;
}
