// The reads: the TiddlyWeb status, the tiddler list, and any object of the bucket by its key (a
// tiddler, a file). design 1.1.

import { backupReport, readBackupStatus } from "./backup/status.js";
import { objectHeaders, parseEtagList, tiddlerEtag, untilDone } from "./http.js";
import { parseList, rebuildList, rebuildingResponse } from "./list.js";
import { LIST_KEY, TIDDLER_PREFIX } from "./storage.js";
import { keyTooLong, revisionOf } from "./tiddlers.js";

// What /status answers on the admin site: TiddlyWeb's status. TiddlyWiki asks for it at every page
// load, before the tiddler list. It never changes, so the browser keeps it for a week (private: for
// that browser only): the next loads don't ask the worker, nor wait for its answer. (The public site
// has its own file, setup 2.8.)
export const ADMIN_STATUS = { username: "admin", read_only: false, anonymous: false, logout_is_available: true, space: { recipe: "default" } };

export const STATUS_CACHE = "private, max-age=604800";

// GET /status: the same answer always, so the browser keeps it (ADMIN_STATUS)
export function serveStatus(corsHeaders) {
  return new Response(JSON.stringify(ADMIN_STATUS), { headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": STATUS_CACHE } });
}

// GET or HEAD of an object of the bucket, by its key (already decoded): a tiddler, with its
// revision in the ETag, or anything else as stored. A browser that has it asks with that ETag
// (If-None-Match, maybe weakened to W/ by Cloudflare's compression) and is answered 304, no body:
// a file isn't even read from R2 (its ETag is R2's); a tiddler is, as its revision is in its
// metadata, and the read is the one R2 operation either way. (The admin wiki reads tiddlers from
// the public site, or has them on the device: it asks the worker for one whose public copy is
// stale or missing, and the conflict guard for the server's version. design 1.5.)
export async function serveObject(request, env, key, corsHeaders) {
  if (keyTooLong(key)) return new Response("Not found", { status: 404, headers: corsHeaders });
  const tiddler = key.startsWith(TIDDLER_PREFIX);
  const known = parseEtagList(request.headers.get("If-None-Match")).filter(token => token !== "*");
  const object = await env.WIKI_BUCKET.get(key, !tiddler && known.length > 0 ? { onlyIf: { etagDoesNotMatch: known[0] } } : undefined);
  if (!object) return new Response("Not found", { status: 404, headers: corsHeaders });
  const headers = objectHeaders(object, corsHeaders);
  let unchanged = !("body" in object);   // a conditional get whose precondition failed: the browser has it
  if (tiddler) {
    // Stored with its revision, bag and recipe already in place: served as is
    const revision = revisionOf(object);
    headers.set("Cache-Control", "no-cache");
    headers.set("ETag", tiddlerEtag(key.slice(TIDDLER_PREFIX.length), revision));
    unchanged = known.includes(revision);
  } else {
    headers.set("ETag", object.httpEtag);
  }
  if (unchanged || request.method !== "GET") {
    if ("body" in object) await object.body.cancel();
    return new Response(null, { status: unchanged ? 304 : 200, headers });
  }
  return new Response(object.body, { headers });
}

// Serves the tiddler list, answering 304 when the browser already has the current version
export async function serveList(request, env, ctx, corsHeaders) {
  // Our ETag is "<R2 etag>-patched"; Cloudflare's compression may hand it back weakened as W/"..."
  const known = parseEtagList(request.headers.get("If-None-Match")).find(token => token.endsWith("-patched"));
  // The admin wiki asks how backups go with this request (design 1.7): read at the same time
  const [listObject, backups] = await Promise.all([
    env.WIKI_BUCKET.get(LIST_KEY, known ? { onlyIf: { etagDoesNotMatch: known.slice(0, -"-patched".length) } } : undefined),
    request.headers.get("X-Backup-Status") === "ask" ? readBackupStatus(env) : null
  ]);
  let object = listObject;
  const listHeaders = obj => {
    const headers = listResponseHeaders(obj, corsHeaders);
    if (backups) headers.set("X-Backup-Status", backupReport(env, backups));
    return headers;
  };
  // A conditional get that fails its precondition returns the object without a body
  if (object && !("body" in object)) return new Response(null, { status: 304, headers: listHeaders(object) });

  let text = object ? await object.text() : null;
  let list = text === null ? null : parseList(text);
  // Every entry the worker writes has its bag and recipe: then the list is served as stored, not
  // written out again (which costs about as much CPU as reading it)
  if (list && list.every(t => t.bag && t.recipe)) return new Response(text, { headers: listHeaders(object) });
  if (!list) {
    // Missing or damaged: rebuilt from the stored tiddlers. (Answering [] would make every open tab
    // remove all its tiddlers as "missing from the server".)
    const rebuilt = await untilDone(ctx, rebuildList(env, ctx, { object, text }));
    // Just rebuilt: served as written (every entry already has its bag and recipe)
    if (rebuilt?.fresh) return new Response(rebuilt.text, { headers: listHeaders(rebuilt.object) });
    list = rebuilt?.entries;
    if (!list) return rebuildingResponse(corsHeaders);
    object = rebuilt.object;
  }
  // Written by hand, say
  list = list.map(t => ({ ...t, bag: t.bag || "default", recipe: t.recipe || "default" }));
  return new Response(JSON.stringify(list), { headers: listHeaders(object) });
}

function listResponseHeaders(object, corsHeaders) {
  const headers = objectHeaders(object, corsHeaders);
  headers.set("Cache-Control", "no-cache");
  headers.set("ETag", `"${object.etag}-patched"`);
  return headers;
}
