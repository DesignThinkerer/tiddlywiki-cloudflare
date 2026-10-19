// A full backup, started from the admin wiki (design 1.7): POST /backup/sync queues the job that
// makes GitHub mirror the bucket (queue.js, syncStep), GET /backup/sync says how the last one went.
// For tiddlers that predate the backup (imported before the repository and the token were set), a
// restore, a tiddler put in R2 by hand, or any doubt. Idempotent: run again, it commits nothing.

import { guideText } from "../docs.js";
import { refusal } from "../http.js";
import { failureResponse, readableList } from "../list.js";
import { github } from "../settings.js";
import { readBackupStatus, recordSync, syncRunning } from "./status.js";

// A full backup's status as answered, with whether it's running
function jsonResponse(sync, status, corsHeaders) {
  const value = sync && sync.id ? { ...sync, running: syncRunning(sync) } : sync;
  return new Response(JSON.stringify(value), { status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// POST /backup/sync: 202 with the new full backup's status; 409 with the running one's if there is
// one; 400 without backups, or without the queue the job runs in
export async function startBackupSync(request, env, ctx, corsHeaders) {
  if (!github(env)) return refusal("Backups aren't set up: the worker has no GITHUB_REPO and GITHUB_TOKEN (" + guideText("setup", "2.4") + ").", corsHeaders);
  if (!env.BACKUP_QUEUE) return refusal("A full backup runs in the backup queue, which this worker doesn't have (" + guideText("setup", "2.3") + ").", corsHeaders);
  try {
    const status = await readBackupStatus(env, true);
    if (syncRunning(status.sync)) return jsonResponse(status.sync, 409, corsHeaders);
    // The tiddler list says how many there are (a missing or damaged one is rebuilt first, 503 meanwhile)
    const { entries } = await readableList(env, ctx);
    const now = Date.now(), id = `${now}-${crypto.randomUUID().slice(0, 8)}`;
    const start = { id, total: entries.length, done: 0, committed: 0, removed: 0, failed: 0, steps: 0 };
    // Recorded first: a step checks it's the current full backup before working (queue.js)
    let sync = await recordSync(env, { ...start, startedAt: now, phase: "push" }, status);
    try {
      await env.BACKUP_QUEUE.send({ action: "sync", startedAt: now, phase: "push", after: null, time: now, tries: 0, ...start });
    } catch (e) {
      sync = await recordSync(env, { id, finished: now, error: `The queue didn't take the job: ${e.message}` });
      return jsonResponse(sync, 503, corsHeaders);
    }
    return jsonResponse(sync, 202, corsHeaders);
  } catch (error) {
    return failureResponse("Full backup", error, corsHeaders);
  }
}

// GET /backup/sync: the last full backup's status, {} if there never was one
export async function backupSyncStatus(env, corsHeaders) {
  const status = await readBackupStatus(env);
  return jsonResponse(status.sync || {}, 200, corsHeaders);
}
