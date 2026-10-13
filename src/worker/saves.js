// Saves and deletes (design 1.4): the precondition check, the conditional write, the list update,
// the purge, the backup, and the page and plugin file when the tiddler is one the page needs.

import { queueBackup } from "./backup/queue.js";
import { purgePublicCache, tiddlerPurgeUrls } from "./cache.js";
import { checkPreconditions, conflictResponse, decodePath, invalidPath, savedResponse, untilDone } from "./http.js";
import { BadSave, FLAT_LAYOUT, keepStoredText, readSave, storedFields, storesSameContent } from "./layout.js";
import { failureResponse, listedRevision, readableList, removeFromList, updateList } from "./list.js";
import { rebuildPage } from "./page.js";
import { deletePluginFile, pluginFileKey } from "./plugins.js";
import { TIDDLER_PREFIX } from "./storage.js";
import { MAX_KEY_BYTES, isDraft, isEphemeralTitle, isPageTiddler, keyTooLong, needsPluginFile, revisionOf, tiddlerKey } from "./tiddlers.js";

// PUT recipes/default/tiddlers/<title>: a save (design 1.4)
export async function handleSave(request, env, ctx, url, corsHeaders) {
  try {
    const match = url.pathname.match(/^\/recipes\/default\/tiddlers\/(.+)$/);
    if (!match) return new Response("Invalid PUT path", { status: 400, headers: corsHeaders });

    const title = decodePath(match[1]);
    if (title === null) return invalidPath(corsHeaders);
    let save = await readSave(request);
    // Stored and listed under the title in the URL: a different one in the body would make the
    // list disagree with the stored tiddlers (the browser always sends the same one)
    if (save.fields.title !== title) throw new BadSave("the title in the body isn't the one in the URL");

    if (isEphemeralTitle(title) || isDraft(save.fields)) {
      return savedResponse(title, Date.now().toString(), corsHeaders);
    }
    if (keyTooLong(tiddlerKey(title))) {
      throw new BadSave(`the title is too long: R2 keys hold at most ${MAX_KEY_BYTES - TIDDLER_PREFIX.length} bytes of it (UTF-8)`);
    }

    // The stored tiddler and the tiddler list, read at once (one round trip, not two). While a
    // damaged list is being rebuilt, readableList throws: the save is refused (503) without
    // changing anything, so the browser's retry can't conflict with it.
    // (A save without its text, keepStoredText, reads the stored text too.)
    const key = tiddlerKey(title), skinny = Object.hasOwn(save.fields, "_is_skinny");
    const [current, list] = await Promise.all([skinny ? env.WIKI_BUCKET.get(key) : env.WIKI_BUCKET.head(key), readableList(env, ctx)]);
    const currentRevision = current ? revisionOf(current) : null;
    if (skinny) save = await keepStoredText(save, current);

    const { conditional, reason } = checkPreconditions(request, currentRevision);
    if (reason) {
      // A retry of a save that was stored but whose list update then failed: the stored tiddler
      // is exactly what this save would store, so finish that save instead of refusing it.
      // (Otherwise the browser sees the identical copy, adopts it, and the list is never fixed.)
      if (current && await storesSameContent(env, current, save, currentRevision)) {
        await untilDone(ctx, finishSave(env, ctx, title, save.fields, currentRevision, list, url.origin, true));
        return savedResponse(title, currentRevision, corsHeaders);
      }
      // The stored tiddler isn't the version the list has: a save whose list update failed, retried
      // with other content (edited again since) or not at all (its tab closed). Refused all the same,
      // since it isn't based on that version (only the conflict guard can tell its own save, design
      // 1.4), but that save is finished: the list, the public cache and the page catch up with it.
      if (current && listedRevision(list, title) !== currentRevision) {
        const fields = await storedFields(env, current);
        if (fields) await untilDone(ctx, finishSave(env, ctx, title, fields, currentRevision, list, url.origin, true));
      }
      return conflictResponse(title, reason, currentRevision, corsHeaders);
    }

    const newRevision = Date.now().toString();
    const body = save.stored(newRevision);
    const putOptions = {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { revision: newRevision, layout: FLAT_LAYOUT }
    };

    if (conditional) {
      // Only write if the object is still exactly the one we checked (or still absent)
      let written = await env.WIKI_BUCKET.put(key, body, {
        ...putOptions,
        onlyIf: current ? { etagMatches: current.etag } : new Headers({ "If-None-Match": "*" })
      });
      if (written === null && !current && !(await env.WIKI_BUCKET.head(key))) {
        // A create-only write was refused but nothing is there: write it normally
        written = await env.WIKI_BUCKET.put(key, body, putOptions);
      }
      if (written === null) {
        const latest = await env.WIKI_BUCKET.head(key);
        return conflictResponse(title, "it was changed in another tab or browser", latest ? revisionOf(latest) : null, corsHeaders);
      }
    } else {
      await env.WIKI_BUCKET.put(key, body, putOptions);
    }

    ctx.waitUntil(queueBackup(env, { action: "save", title, revision: newRevision, content: body }));
    await untilDone(ctx, finishSave(env, ctx, title, save.fields, newRevision, list, url.origin));

    return savedResponse(title, newRevision, corsHeaders);
  } catch (error) {
    return failureResponse("Save failed", error, corsHeaders);
  }
}

// DELETE bags/<bag>/tiddlers/<title> (or recipes/<recipe>/...): a delete (design 1.4)
export async function handleDelete(request, env, ctx, url, corsHeaders) {
  try {
    const match = url.pathname.match(/^\/(?:bags|recipes)\/[^/]+\/tiddlers\/(.+)$/);
    if (!match) return new Response("Invalid DELETE path", { status: 400, headers: corsHeaders });

    const title = decodePath(match[1]);
    if (title === null) return invalidPath(corsHeaders);
    // The story list, state and temp tiddlers are never stored, nor a title too long for a key,
    // so there is nothing to delete or back up
    if (isEphemeralTitle(title) || keyTooLong(tiddlerKey(title))) return new Response(null, { status: 204, headers: corsHeaders });

    // Read first, like a save (see there). The check below is then followed at once by the
    // delete, which can't be made conditional.
    const list = await readableList(env, ctx);
    const found = await env.WIKI_BUCKET.head(tiddlerKey(title));
    let currentRevision;
    if (found) {
      currentRevision = revisionOf(found);
      const { reason } = checkPreconditions(request, currentRevision);
      if (reason) return conflictResponse(title, reason, currentRevision, corsHeaders);
      await env.WIKI_BUCKET.delete(found.key);
    }
    // Queued before the list update, which may fail (the retry then finds nothing to delete)
    if (found) ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
    await untilDone(ctx, (async () => {
      // If it was neither stored nor listed, there is nothing to back up or purge
      let { removed, list: stored, recreated } = await removeFromList(env, ctx, title, list, found ? currentRevision : null);
      if (recreated) {
        // Saved again since: that save's purge, plugin file and page build are the ones. Unless that
        // save landed between the check above and the delete, which then removed it too (an R2
        // delete can't be conditional): nothing is stored, so the entry goes as well
        if (await env.WIKI_BUCKET.head(tiddlerKey(title))) return;
        ({ removed, list: stored } = await removeFromList(env, ctx, title, stored));
      }
      if (!found && removed) ctx.waitUntil(queueBackup(env, { action: "delete", title, revision: currentRevision }));
      if (found || removed) ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title, url.origin)));
      // Neither stored nor listed: a retry of a delete that failed after both were done, whose page
      // build failed and was never marked outdated (rebuildPage): the plugin file is the only trace left
      const leftover = !found && !removed && !!(await env.WIKI_BUCKET.head(pluginFileKey(title)));
      // The list entry says what it was; if it wasn't listed, rebuild the page for system tiddlers,
      // and delete any plugin file anyway (deleting a missing object is free), once the page is
      // rebuilt without it (see deletePluginFile)
      if (removed ? isPageTiddler(removed) : (found && title.startsWith("$:/")) || leftover) {
        await rebuildPage(env, ctx, stored);
      }
      if (removed ? needsPluginFile(removed) : found || leftover) await deletePluginFile(env, title);
    })());

    return new Response(null, { status: 204, headers: corsHeaders });
  } catch (error) {
    return failureResponse("Delete failed", error, corsHeaders);
  }
}

// The rest of a save once the tiddler is stored: the tiddler list, the public cache and the page.
// list: the list as read before the tiddler was stored (readableList), or null to read it here.
// adminOrigin: the admin site's origin (where this request came to), see tiddlerPurgeUrls.
// retried: this is a save sent again (its first answer lost, or its list update failed): the list
// may already say what it would say, so what's left of the first attempt is found another way.
async function finishSave(env, ctx, title, fields, revision, list, adminOrigin, retried = false) {
  const { previous, list: stored, superseded, gone } = await updateList(env, ctx, title, fields, revision, list);
  // A newer save of this tiddler got there first, or a delete removed it meanwhile: that request's
  // purge, plugin file and page build are the ones
  if (superseded || gone) return;
  // Only once the new list is in R2: a public request between the purge and the list update
  // would put the old list back in Cloudflare's cache
  ctx.waitUntil(purgePublicCache(env, tiddlerPurgeUrls(env, title, adminOrigin)));
  const saved = { ...fields, title };
  const wasPlugin = previous && needsPluginFile(previous);
  // A plugin saved as an ordinary tiddler, whose page build failed and was never marked outdated:
  // the retry's list already has the ordinary tiddler, and the file is the only trace left
  const leftover = retried && !wasPlugin && !needsPluginFile(saved) && !!(await env.WIKI_BUCKET.head(pluginFileKey(title)));
  // Something the page needs at boot was added, changed or is no longer needed: rebuild the
  // page (which writes the plugin file) before confirming, so a reload right after has it
  if (isPageTiddler(saved) || (previous && isPageTiddler(previous)) || leftover) {
    await rebuildPage(env, ctx, stored);
  }
  // No longer a plugin: its file goes, now that the page doesn't load it
  if ((wasPlugin || leftover) && !needsPluginFile(saved)) await deletePluginFile(env, title);
}
