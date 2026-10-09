// The GitHub backup through a Cloudflare Queue (README 4.7): every save or delete becomes one
// message. The queue consumer (processBackupBatch, configured with max_concurrency 1) commits them
// one at a time, in order, one commit per save, so commits never collide, and GitHub rate limits or
// outages only delay backups: failed messages are put back with a growing delay until they go
// through. A rate limit or a token GitHub refuses pauses every backup; any other failure holds up
// only that tiddler's versions, so a file GitHub refuses can't hold up the others. Nothing runs
// while the queue is empty. Without a BACKUP_QUEUE binding (or if the queue is unavailable) the
// same backup runs directly.

import { decoder, encoder } from "../bytes.js";
import { github } from "../settings.js";
import { isNewerRevision, revisionOf, tiddlerKey } from "../tiddlers.js";
import { backupRetryDelay, gitBlobSha, githubContents, isAccountWide, isRateLimit, isRefusal } from "./github.js";
import { backupFailure, nextPause, readBackupStatus, recordBackupResults } from "./status.js";

// A queue message, as sent: a version that would make it bigger waits in R2. (The queue takes up to
// 128 KB, but counts an operation per 64 KB of message: over 64 KB, a backup would cost 6 instead of 3.)
const QUEUE_MESSAGE_LIMIT = 64000;

const BACKUP_PER_RUN = 10;

// After this many bytes of versions, the rest of a run goes on to the next one: a megabyte takes a
// few milliseconds of CPU (its base64 above all), and a run gets about 10 on the free plan. A run
// always backs up one version, whatever its size.
const BACKUP_BYTES_PER_RUN = 512 * 1024;

// About the size of a message as the queue measures it: V8-serialized, where a string takes one
// byte a character if they're all Latin-1, two otherwise (so a text of 40 KB can be over 64 KB), with
// room for the other fields
function queueMessageSize(message) {
  let size = 200;
  for (const value of [message.title, message.content]) {
    if (typeof value === "string") size += value.length * (/[^\x00-\xff]/.test(value) ? 2 : 1);
  }
  return size;
}

// Called after a save or delete has been stored; job.content is the stored bytes
export async function queueBackup(env, job) {
  if (!github(env)) return;
  const message = { action: job.action, title: job.title, revision: job.revision ?? null, time: Date.now(), tries: 0 };
  if (env.BACKUP_QUEUE) {
    try {
      if (job.action === "save") {
        // (Decoded only if it may fit: a character is at least one byte of UTF-8)
        const content = job.content.length < QUEUE_MESSAGE_LIMIT ? decoder.decode(job.content) : null;
        if (content !== null && queueMessageSize({ ...message, content }) <= QUEUE_MESSAGE_LIMIT) {
          message.content = content;
        } else {
          // Keep this exact version until it is committed (R2 itself only holds the latest one).
          // Not named after the title, which can be too long for a key (or guessed: the copy is public)
          message.contentKey = `_backup/versions/${message.time}-${crypto.randomUUID()}.json`;
          await env.WIKI_BUCKET.put(message.contentKey, job.content, { httpMetadata: { contentType: "application/json" } });
        }
      }
      await env.BACKUP_QUEUE.send(message);
      return;
    } catch (e) {
      console.error(`[Backup] Could not queue '${job.title}', backing up directly:`, e.message);
      if (message.contentKey) await env.WIKI_BUCKET.delete(message.contentKey).catch(() => {});
    }
  }
  // No queue: run the same backup right away, with a couple of quick retries
  const direct = { ...message, content: job.content, contentKey: undefined };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await backupJob(env, direct);
      return await recordBackupResults(env, [], [job.title]);
    } catch (e) {
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      console.error(`[Backup] '${job.title}' could not be backed up:`, e.message);
      await recordBackupResults(env, [backupFailure(direct, e)], []);
    }
  }
}

// The pause of every backup, if one is on (nextPause in status.js), kept for the later runs in this isolate
let backupPause = null;

// Queue consumer
export async function processBackupBatch(batch, env) {
  const messages = [...batch.messages].sort((a, b) =>
    (a.body.time - b.body.time) || String(a.body.revision).localeCompare(String(b.body.revision)));
  const held = new Map();   // title -> delay: a version of it failed, its later versions wait with it
  const failures = [], cleared = [];   // for the backup status (backupFailure)
  let pause;                // for the status file: a pause that starts in this run, or null if one is over
  let stored;               // the status file, if read in this run
  let denied;               // a tiddler GitHub answered 403 or 404 in this run (see isAccountWide)
  let attempts = 0;
  const work = { bytes: 0 };   // the size of the versions handled so far (BACKUP_BYTES_PER_RUN)
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (backupPause && Date.now() < backupPause.until) {
      // Waits for the pause to end. (Marked, so that its backup going through ends the pause in the
      // status file too)
      await requeueBackup(env, msg, Math.ceil((backupPause.until - Date.now()) / 1000), false, { paused: true });
      if (backupPause.all) failures.push(backupFailure(msg.body, backupPause.error));
      continue;
    }
    if (held.has(msg.body.title)) {
      await requeueBackup(env, msg, held.get(msg.body.title), false);
      continue;
    }
    if (attempts >= BACKUP_PER_RUN || work.bytes >= BACKUP_BYTES_PER_RUN) {
      await requeueBackup(env, msg, 0, false);
      continue;
    }
    attempts++;
    try {
      await backupJob(env, msg.body, work);
      msg.ack();
      backupPause = null;   // GitHub takes backups (again)
      // (The backup is done: a copy that can't be removed is only left behind)
      if (msg.body.contentKey) await env.WIKI_BUCKET.delete(msg.body.contentKey).catch(() => {});
      // Only a version that failed or waited before can clear a recorded failure, or a recorded pause
      if (msg.body.tries > 0 || msg.body.paused || msg.attempts > 1) {
        cleared.push(msg.body.title);
        pause = null;
      }
    } catch (e) {
      if (isRateLimit(e) || e.status === 401 || (isAccountWide(e) && denied !== undefined && denied !== msg.body.title)) {
        // Every backup waits: this one, the rest of this run (above), and the next runs. (A rate
        // limit isn't a failure to report: a big import waits like this for hours.)
        let last = backupPause;
        if (!last) {
          try {
            stored = await readBackupStatus(env, true);
            last = stored.pause;
          } catch {}
        }
        backupPause = nextPause(env, last, e);
        pause = { until: backupPause.until, count: backupPause.count };
        const delay = Math.ceil((backupPause.until - Date.now()) / 1000);
        console.error(`[Backup] Backups paused for ${delay}s: ${e.message}`);
        await requeueBackup(env, msg, delay, true);
        if (backupPause.all) failures.push(backupFailure(msg.body, e));
        continue;
      }
      if (isAccountWide(e)) denied = msg.body.title;
      const delay = backupRetryDelay(env, msg.body.tries, e.retryAfter);
      console.error(`[Backup] '${msg.body.title}' not backed up yet (${e.message}); retrying in ${delay}s`);
      await requeueBackup(env, msg, delay, true, isRefusal(e) ? { refused: true } : undefined);
      // Anything else may concern this file only, and other tiddlers' backups go ahead. Its later
      // versions wait with it, so they stay in order, unless GitHub refuses this version for good
      // (its path, or a secret in its text): the next one may be fine, and goes ahead (the late
      // versions logic keeps GitHub on the newest)
      if (!isRefusal(e)) held.set(msg.body.title, delay);
      failures.push(backupFailure(msg.body, e));
    }
  }
  if (failures.length || cleared.length || pause !== undefined) await recordBackupResults(env, failures, cleared, pause, stored);
}

// The queue's retry limit, which the worker can't read: Cloudflare's default (README 3.4: leave it)
const QUEUE_RETRIES = 3;

// How long the queue keeps a message from when it was sent: 24 hours on the free plan (the least)
const QUEUE_RETENTION = 24 * 3600 * 1000;

// Puts a message back, to be delivered again after delaySeconds. While it only waits (nothing in it
// changes but being marked paused, which its next delivery shows anyway: msg.attempts) and has a
// retry left, with a delivery to spare, before the queue would drop it, by its retry limit or its
// retention, the queue's own retry: 1 operation, the next delivery. Otherwise it's sent again as a
// fresh message, which neither limit applies to: 3 operations (sent, delivered, acknowledged).
// countTry: one more failed try; extra: fields to add to it
async function requeueBackup(env, msg, delaySeconds, countTry, extra) {
  const onlyWaits = !countTry && (!extra || (Object.keys(extra).length === 1 && extra.paused === true));
  const sent = msg.timestamp instanceof Date ? msg.timestamp.getTime() : NaN;
  if (onlyWaits && msg.attempts >= 1 && msg.attempts < QUEUE_RETRIES &&
      Date.now() + delaySeconds * 1000 < sent + QUEUE_RETENTION - 3600 * 1000) {
    msg.retry(delaySeconds > 0 ? { delaySeconds } : undefined);
    return;
  }
  const body = { ...msg.body, ...(countTry ? { tries: (msg.body.tries || 0) + 1 } : {}), ...extra };
  try {
    await env.BACKUP_QUEUE.send(body, delaySeconds > 0 ? { delaySeconds } : undefined);
    msg.ack();
  } catch (e) {
    msg.retry(delaySeconds > 0 ? { delaySeconds } : undefined);
  }
}

// Commits one save or delete. job.content: the version as text (in a queue message) or bytes (a
// direct backup). work.bytes: adds the size of the versions it handles
export async function backupJob(env, job, work = { bytes: 0 }) {
  const github = githubContents(env);
  const current = await env.WIKI_BUCKET.head(tiddlerKey(job.title));   // the version in the wiki now

  if (job.action === "delete") {
    if (current) return; // Recreated since then: its own save message updates GitHub
    const existing = await github.get(job.title);
    if (existing) await github.remove(job.title, existing.sha, `🗑️ Delete: ${job.title}`);
    return;
  }

  // (As bytes: what GitHub gets, and what its sha is computed from)
  let content = typeof job.content === "string" ? encoder.encode(job.content) : job.content;
  if (content === undefined && job.contentKey) {
    const stored = await env.WIKI_BUCKET.get(job.contentKey);
    content = stored ? new Uint8Array(await stored.arrayBuffer()) : undefined;
  }
  if (content === undefined) return; // Already handled by an earlier delivery of this message
  work.bytes += content.length;

  // GitHub needs the sha of the file it holds to replace it. Its content isn't needed (decoding a
  // plugin's took more CPU than a run is allowed): whether GitHub already holds a newer version is
  // told by the sha too, compared with the wiki's current version's
  const existing = await github.get(job.title);
  let sha = existing ? existing.sha : null;
  const newer = await newerInWiki(env, job, current, sha, work);
  // A version GitHub refused for good, now replaced there by a newer one, or whose tiddler has been
  // deleted since: dropped, rather than tried forever (it would only have been history)
  if (job.refused && (newer || !current)) return;
  // (A retry after the restore below failed: this version is already in the history, even if a
  // newer one has been committed on top since)
  if (!job.restore && sha !== await gitBlobSha(content)) {
    sha = await github.put(job.title, content, `✏️ Save: ${job.title}`, sha);
  }
  if (newer) {
    // This version arrived after a newer one was committed: it is now in the history, and the
    // newer version goes back on top. (Marked first: if putting it back fails, the retry of this
    // message, which finds this version already committed, still does it.)
    job.restore = true;
    if (sha !== newer.sha) await github.put(job.title, newer.bytes, `✏️ Save: ${job.title} (newer version restored)`, sha);
  } else if (!current) {
    // Deleted since this save: keep this version in the history, then delete it again
    await github.remove(job.title, sha, `🗑️ Delete: ${job.title}`);
  }
}

// The wiki's current version of a tiddler, { bytes, sha }, if it's newer than this job's and GitHub
// already holds it (githubSha), so this job's version arrived late; or if an earlier try of this
// job found that (job.restore). Otherwise null: a newer version still waiting for its own backup
// (quick successive edits) is committed by its own message, in order.
async function newerInWiki(env, job, current, githubSha, work) {
  if (!current || !isNewerRevision(revisionOf(current), job.revision) || (!githubSha && !job.restore)) return null;
  const obj = await env.WIKI_BUCKET.get(tiddlerKey(job.title));
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  work.bytes += bytes.length;
  const sha = await gitBlobSha(bytes);
  return job.restore || sha === githubSha ? { bytes, sha } : null;
}
