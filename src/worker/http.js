// The small shared pieces of answering a request: paths, ETags and preconditions (design 1.2),
// standard answers, and work that outlives the answer.
//
// Edit-conflict protection, in short:
//  * Every tiddler has a revision: customMetadata.revision, a millisecond timestamp set on each
//    save. GET returns it in the body and in the ETag "default/<title>/<revision>:auto".
//  * The conflict guard (src/browser/conflict-guard.js, built into the page) sends the revision its edit
//    is based on as If-Match, or If-None-Match: * for a brand new tiddler.
//  * PUT/DELETE answer 412 when that revision is no longer current (checkPreconditions), and the R2
//    write itself is conditional (saves.js), so two saves arriving at the same moment can't both win.
//  * Requests without If-Match/If-None-Match (old tabs, scripts) are accepted.

// A path, or the title in one, decoded; null if it isn't valid percent-encoding
export function decodePath(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

export function invalidPath(corsHeaders) {
  return new Response("Invalid path: it isn't valid percent-encoding", { status: 400, headers: corsHeaders });
}

export function tiddlerEtag(title, revision) {
  return `"default/${encodeURIComponent(title)}/${revision}:auto"`;
}

// Turns an If-Match / If-None-Match header into revisions ("*" stays "*"). Accepts full TiddlyWeb
// ETags ("bag/title/revision:hash"), bare revisions, and weak (W/) or unquoted forms.
export function parseEtagList(header) {
  if (!header) return [];
  return header.split(",")
    .map(token => token.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1").trim())
    .map(token => {
      if (token === "*") return token;
      const slash = token.lastIndexOf("/");
      const colon = token.lastIndexOf(":");
      return colon > slash ? token.substring(slash + 1, colon) : token.substring(slash + 1);
    })
    .filter(revision => revision && revision !== "undefined" && revision !== "null");
}

// Evaluates If-Match / If-None-Match against the current revision (null if the tiddler doesn't exist)
export function checkPreconditions(request, currentRevision) {
  const ifMatch = parseEtagList(request.headers.get("If-Match"));
  const ifNoneMatch = parseEtagList(request.headers.get("If-None-Match"));
  let reason = null;
  if (ifMatch.length > 0) {
    if (currentRevision === null) reason = "it was deleted in another tab or browser";
    else if (!ifMatch.includes("*") && !ifMatch.includes(currentRevision)) reason = "it was changed in another tab or browser";
  }
  if (!reason && ifNoneMatch.length > 0 && currentRevision !== null &&
      (ifNoneMatch.includes("*") || ifNoneMatch.includes(currentRevision))) {
    reason = "a tiddler with this title was created in another tab or browser";
  }
  return { conditional: ifMatch.length > 0 || ifNoneMatch.length > 0, reason };
}

// Response headers for an R2 object: its stored HTTP metadata plus CORS
export function objectHeaders(object, corsHeaders) {
  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  return headers;
}

export function conflictResponse(title, reason, currentRevision, corsHeaders) {
  const headers = { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (currentRevision !== null) headers.ETag = tiddlerEtag(title, currentRevision);
  return new Response(`Edit conflict: '${title}' was not saved because ${reason}.`, { status: 412, headers });
}

// The answer to a save: TiddlyWiki reads the new revision from the ETag
export function savedResponse(title, revision, corsHeaders) {
  return new Response(null, { status: 204, headers: { ...corsHeaders, ETag: tiddlerEtag(title, revision) } });
}

export function refusal(message, corsHeaders, status = 400) {
  return new Response(message, { status, headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });
}

// Waits for work the response depends on, and keeps it running even if the browser disconnects
// first (a reload while the page is being rebuilt, say): without waitUntil it could be cancelled
export function untilDone(ctx, promise) {
  ctx.waitUntil(promise.catch(() => {}));
  return promise;
}
