// The GitHub backup through a Cloudflare Queue (design 1.7): every save or delete becomes one
// message. The queue consumer (processBackupBatch, configured with max_concurrency 1) commits them
// one at a time, in order, one commit per save, so commits never collide, and GitHub rate limits or
// outages only delay backups: failed messages are put back with a growing delay until they go
// through. A rate limit or a token GitHub refuses pauses every backup; any other failure holds up
// only that tiddler's versions, so a file GitHub refuses can't hold up the others. Nothing runs
// while the queue is empty. Without a BACKUP_QUEUE binding (or if the queue is unavailable) the
// same backup runs directly.
// A full backup (started from the admin wiki, sync.js) runs here too, as a job that walks the stored
// tiddlers a step at a time and queues its next step (syncStep): GitHub ends up mirroring the bucket.

import { decoder, encoder } from "../bytes.js";
import { FLAT_LAYOUT } from "../layout.js";
import { github, waitMs } from "../settings.js";
import { TIDDLER_PREFIX } from "../storage.js";
import { isEphemeralTitle, isNewerRevision, revisionOf, tiddlerKey } from "../tiddlers.js";
import { backupRetryDelay, gitBlobSha, githubContents, isAccountWide, isRateLimit, isRefusal } from "./github.js";
import { BIG_BACKUP_BYTES, QUEUE_RETRIES, backupFailure, nextPause, noteRunning, readBackupStatus, recordBackupResults, recordSync } from "./status.js";

// A queue message, as sent: a version that would make it bigger waits in R2. (The queue takes up to
// 128 KB, but counts an operation per 64 KB of message: over 64 KB, a backup would cost 6 instead of 3.)
const QUEUE_MESSAGE_LIMIT = 64000;

const BACKUP_PER_RUN = 10;

// After this many bytes of versions, the rest of a run goes on to the next one: a megabyte takes a
// couple of milliseconds of CPU (its git hash, its base64, its copy), and a run gets about 10 on the
// free plan. A run always backs up one version, whatever its size.
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
        await new Promise(resolve => setTimeout(resolve, waitMs(env, 1000 * attempt)));
        continue;
      }
      console.error(`[Backup] '${job.title}' could not be backed up:`, e.message);
      await recordBackupResults(env, [backupFailure(direct, e)], []);
    }
  }
}

// The pause of every backup, if one is on (nextPause in status.js), kept for the later runs in this isolate
let backupPause = null;

// The titles recorded as failing in the status file (status.js), as this instance knows them: read
// once, at its first backup that goes through (the file is otherwise read only by a run with a
// failure, a retry or a pause), then kept up to date with what it records and clears. null until
// then. A backup of such a title that goes through clears its entry whatever its own history: a
// fresh save of a tiddler a full backup found refused, fixed since, say.
let failingTitles = null;

async function recordedAsFailing(env, title) {
  if (failingTitles === null) {
    try {
      failingTitles = new Set((await readBackupStatus(env, true)).failing.keys());
    } catch {
      return false;   // not known this time: the next backup that goes through asks again
    }
  }
  return failingTitles.has(title);
}

function noteFailing(failures) {
  if (failingTitles) for (const failure of failures) failingTitles.add(failure.title);
}

// Queue consumer
export async function processBackupBatch(batch, env) {
  const messages = [...batch.messages].sort((a, b) =>
    (a.body.time - b.body.time) || String(a.body.revision).localeCompare(String(b.body.revision)));
  const held = new Map();   // title -> delay: a version of it failed, its later versions wait with it
  const failures = [], cleared = [], finished = [];   // for the backup status (backupFailure; finished: big versions noted, done with)
  let pause;                // for the status file: a pause that starts in this run, or null if one is over
  let stored;               // the status file, if read in this run
  let denied;               // a tiddler GitHub answered 403 or 404 in this run (see isAccountWide)
  let attempts = 0;
  const work = { bytes: 0, calls: 0 };   // the size of the versions handled so far (BACKUP_BYTES_PER_RUN), the GitHub calls made
  const syncSteps = [];        // a full backup's step, run after the saves with what's left of the run's calls
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (backupPause && Date.now() < backupPause.until) {
      // Waits for the pause to end. (Marked, so that its backup going through ends the pause in the
      // status file too)
      await requeueBackup(env, msg, Math.ceil((backupPause.until - Date.now()) / 1000), false, { paused: true });
      if (backupPause.all && msg.body.action !== "sync") failures.push(backupFailure(msg.body, backupPause.error));
      continue;
    }
    if (msg.body.action === "sync") {
      syncSteps.push(msg);
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
    const delivery = { attempt: msg.attempts };   // (noted: a big version, noted as under way)
    try {
      await backupJob(env, msg.body, work, delivery);
      msg.ack();
      backupPause = null;   // GitHub takes backups (again)
      // (The backup is done: a copy that can't be removed is only left behind)
      if (msg.body.contentKey) await env.WIKI_BUCKET.delete(msg.body.contentKey).catch(() => {});
      // A version that failed or waited before clears a recorded failure, and a recorded pause; so
      // does any version of a title recorded as failing (recordedAsFailing)
      const waited = msg.body.tries > 0 || msg.body.paused || msg.attempts > 1;
      if (waited || await recordedAsFailing(env, msg.body.title)) {
        cleared.push(msg.body.title);
        if (failingTitles) failingTitles.delete(msg.body.title);
        if (waited) pause = null;
      }
    } catch (e) {
      if (delivery.noted) finished.push(msg.body.title);
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
      continue;
    }
    if (delivery.noted) finished.push(msg.body.title);
  }
  // A full backup's step: one a run, with the calls the saves left (a step itself records what it did)
  let stepRun = false;
  for (const msg of syncSteps) {
    const budget = GITHUB_CALLS_PER_RUN - work.calls;
    if (stepRun || budget < SYNC_MIN_CALLS || (backupPause && Date.now() < backupPause.until)) {
      await requeueBackup(env, msg, backupPause && Date.now() < backupPause.until ? Math.ceil((backupPause.until - Date.now()) / 1000) : 0, false);
      continue;
    }
    stepRun = true;
    try {
      const next = await syncStep(env, msg.body, work, budget, { attempt: msg.attempts, sync: msg.body.id });
      msg.ack();
      backupPause = null;
      if (next) await env.BACKUP_QUEUE.send(next);
    } catch (e) {
      if (isRateLimit(e) || isAccountWide(e)) {
        // Every backup waits (as above)
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
        console.error(`[Backup] Backups paused for ${delay}s (full backup, step ${msg.body.steps || 0}): ${e.message}`);
        await requeueBackup(env, msg, delay, true);
        continue;
      }
      const delay = backupRetryDelay(env, msg.body.tries, e.retryAfter);
      console.error(`[Backup] Full backup step not done (${e.message}); trying again in ${delay}s`);
      await requeueBackup(env, msg, delay, true);
    }
  }
  noteFailing(failures);
  if (failures.length || cleared.length || finished.length || pause !== undefined) await recordBackupResults(env, failures, cleared, pause, stored, finished);
}

// --- A full backup (design 1.7): GitHub made to mirror the bucket -----------------------------------
// Started from the admin wiki (POST /backup/sync, sync.js), for tiddlers that predate the backup, a
// restore, a tiddler put in R2 by hand, or any doubt. A message carries where it stands: { action:
// "sync", id, startedAt, phase, after, pending, total, done, committed, removed, failed, steps, time, tries }.
// The push phase walks the stored tiddlers in key order (after: the last key walked), each through the
// same backup as a save (backupJob): nothing is committed for one GitHub has the same bytes of, and a
// file GitHub refuses is reported like a save's would be, the walk going on. Then the prune phase lists
// GitHub's tiddler files in one call (the tree) and removes those whose titles are no longer stored
// (pending: the ones left to remove). Each step stays within a run's budgets: the GitHub calls the
// saves of the same run left (GITHUB_CALLS_PER_RUN), the bytes (BACKUP_BYTES_PER_RUN); a step records
// what it did in the status file (recordSync) and queues the next, so a wiki of any size goes through
// in as many steps as it takes, at 3 queue operations a step. Idempotent: run again, it commits nothing.

// Of the 50 calls a run may make outside Cloudflare; a save's backup takes up to 3
const GITHUB_CALLS_PER_RUN = 40;

// A step starts only with this many calls left in the run (one tiddler takes up to 3)
const SYNC_MIN_CALLS = 8;

const SYNC_LIST_LIMIT = 100;

// What a prune message carries of the files still to remove (titles and shas, as the queue would
// measure them): what fits with room to spare under a message's 64 KB, so a step stays 3 operations;
// more than that, and the tree is listed again once they're removed
const SYNC_PENDING_BYTES = 56 * 1024;

// One step. Returns the next step's message, or null once done. Throws on an error that stops the
// step (GitHub down, a rate limit, a refused token, R2): the step is retried, its progress recorded
// as an error meanwhile. A step of a full backup another one has replaced since (started again
// after this one's step was lost for hours) does nothing.
async function syncStep(env, body, work, budget, delivery) {
  const stored = await readBackupStatus(env, true);
  if (stored.sync && stored.sync.id !== body.id && stored.sync.startedAt > body.time) {
    console.log("[Backup] Sync step of a full backup replaced by a newer one: dropped");
    return null;
  }
  const github = githubContents(env, work);
  const callsAtStart = work.calls;
  const used = () => work.calls - callsAtStart;
  let { done = 0, committed = 0, removed = 0, failed = 0, steps = 0, total = null } = body;
  steps++;
  const failures = [], through = [], finished = [];   // what GitHub refused, the titles it took or already had, the big ones noted
  let next;
  try {
    next = await syncWork(env, github, body, work, budget, used, counts => ({ done, committed, removed, failed } = counts), failures, through, finished, delivery);
  } catch (e) {
    if (finished.length) await recordBackupResults(env, [], [], undefined, undefined, finished);
    await recordSync(env, { id: body.id, error: String(e.detail || e.message || e).slice(0, 200) }, stored).catch(() => {});
    throw e;
  }
  console.log(`[Backup] Sync step ${steps}: ${done}/${total ?? "?"} walked, ${committed} committed, ${removed} removed, ${failed} failed, ${used()} GitHub calls`);
  // A tiddler recorded as failing that this step committed, or found GitHub already has: cleared
  const cleared = through.filter(title => stored.failing.has(title));
  noteFailing(failures);
  if (failingTitles) for (const title of cleared) failingTitles.delete(title);
  if (failures.length || cleared.length || finished.length) await recordBackupResults(env, failures, cleared, undefined, undefined, finished);
  const startedAt = body.startedAt || body.time;
  await recordSync(env, { id: body.id, startedAt, total, phase: next ? next.phase : "prune", steps, done, committed, removed, failed, error: undefined, ...(next ? {} : { finished: Date.now() }) });
  return next ? { action: "sync", id: body.id, startedAt, total, done, committed, removed, failed, steps, time: Date.now(), tries: 0, ...next } : null;
}

// The step's work: the next slice of the push, or of the prune. report(counts) hands back the counts
// as they stand (also when an error stops the step partway); through gets the titles GitHub took or
// already had; finished the big ones noted as under way (noteBigVersion) and done with; delivery:
// the step's message's attempt and the full backup's id, for the notes. Returns what the next step
// is, or null.
async function syncWork(env, github, body, work, budget, used, report, failures, through, finished, delivery) {
  let { done = 0, committed = 0, removed = 0, failed = 0 } = body;
  const counts = () => report({ done, committed, removed, failed });
  if (body.phase === "push") {
    let after = body.after || null, stopped = false;
    for (;;) {
      const listing = await env.WIKI_BUCKET.list({ prefix: TIDDLER_PREFIX, limit: SYNC_LIST_LIMIT, include: ["customMetadata"], ...(after ? { startAfter: after } : {}) });
      for (const item of listing.objects) {
        if (used() + 3 > budget || work.bytes >= BACKUP_BYTES_PER_RUN) {
          stopped = true;
          break;
        }
        const title = item.key.slice(TIDDLER_PREFIX.length);
        // (What the list leaves out is left out here too: an object not in the stored layout)
        if (item.customMetadata?.layout === FLAT_LAYOUT && !isEphemeralTitle(title)) {
          const obj = await env.WIKI_BUCKET.get(item.key);
          if (obj) {
            const job = { action: "save", title, revision: revisionOf(obj), time: Date.now() };
            let noted = await noteBigVersion(env, job, obj.size, delivery);
            job.content = new Uint8Array(await obj.arrayBuffer());
            try {
              if (await backupJob(env, job, work) === "committed") committed++;
              through.push(title);
            } catch (e) {
              if (noted) {
                finished.push(title);   // (done with it, however it went: the note goes with the step's record)
                noted = false;
              }
              if (!isRefusal(e)) throw e;
              failed++;
              failures.push(backupFailure(job, e));
            }
            if (noted) finished.push(title);
          }
        }
        done++;
        after = item.key;
        counts();
      }
      if (stopped || !listing.truncated) break;
    }
    return stopped ? { phase: "push", after } : { phase: "prune" };
  }
  // The prune: GitHub's tiddler files (one call), the stored keys (one R2 call per 1,000), the difference
  let pending = body.pending;
  if (!pending) {
    const files = await github.tiddlerFiles();
    if (files === null) {
      console.error("[Backup] Full backup: GitHub's tree is too big to list in one call, so files of titles no longer in the wiki aren't removed");
      pending = [];
    } else {
      const titles = await storedTitles(env);
      pending = files.filter(file => !titles.has(file.title));
    }
  }
  while (pending.length && used() + 1 <= budget) {
    const file = pending.shift();
    try {
      await github.remove(file.title, file.sha, `🗑️ Full backup: ${file.title} is no longer in the wiki`);
      removed++;
      counts();
    } catch (e) {
      // Gone meanwhile (404), or changed meanwhile, a save that landed (409): left alone
      if (e.status !== 404 && e.status !== 409) throw e;
    }
  }
  if (pending.length) {
    // As many as fit the next message (a title takes two bytes a character past Latin-1, as a text does)
    const carried = [];
    let bytes = 0;
    for (const file of pending) {
      bytes += (file.title.length + file.sha.length + 32) * (/[^\x00-\xff]/.test(file.title) ? 2 : 1);
      if (bytes > SYNC_PENDING_BYTES && carried.length) break;
      carried.push(file);
    }
    // (more: files past this message, to find by listing the tree again once these are removed;
    // kept from the message before, where the list came from, until that listing)
    return { phase: "prune", pending: carried, ...(carried.length < pending.length || body.more ? { more: true } : {}) };
  }
  return body.more ? { phase: "prune" } : null;
}

// The titles of every stored tiddler (its key without the prefix), 1,000 a call
async function storedTitles(env) {
  const titles = new Set();
  let cursor;
  do {
    const listing = await env.WIKI_BUCKET.list({ prefix: TIDDLER_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of listing.objects) titles.add(item.key.slice(TIDDLER_PREFIX.length));
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return titles;
}

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

// A version over BIG_BACKUP_BYTES, about to be backed up from the queue (delivery: { attempt, sync }):
// noted in the status file as under way (status.js, noteRunning), before the heavy part — the bytes
// copied, hashed and encoded, which on the free plan can take a run past its CPU time, after which
// nothing runs, the queue delivers the message again the same way, three times, then drops it, and
// this note is all that says why. The run clears it once done with the version (finished). Not for
// a direct backup (no queue: the save's own request, which answers its error). Returns whether noted.
async function noteBigVersion(env, job, size, delivery) {
  if (!delivery || !(size > BIG_BACKUP_BYTES)) return false;
  await noteRunning(env, { title: job.title, revision: job.revision, size, started: Date.now(), attempt: delivery.attempt, sync: delivery.sync });
  delivery.noted = true;
  return true;
}

// Commits one save or delete. job.content: the version as text (in a queue message) or bytes (a
// direct backup). work.bytes: adds the size of the versions it handles; work.calls: the GitHub calls.
// delivery: from the queue, { attempt, sync } (noted set here when the version got a note, see
// noteBigVersion). Returns "committed" when it wrote GitHub's file, "same" when GitHub already had
// these bytes
export async function backupJob(env, job, work = { bytes: 0, calls: 0 }, delivery = null) {
  const github = githubContents(env, work);
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
    if (stored) await noteBigVersion(env, job, stored.size, delivery);
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
  let outcome = "same";
  if (!job.restore && sha !== await gitBlobSha(content)) {
    sha = await github.put(job.title, content, `✏️ Save: ${job.title}`, sha);
    outcome = "committed";
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
  return outcome;
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
