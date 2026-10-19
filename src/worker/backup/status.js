// How backups go, for the admin wiki (design 1.7): backups GitHub keeps refusing (not a rate limit:
// that only delays them) are recorded in _backup/status.json, one entry per tiddler: since (when its
// oldest waiting version was saved), last (its latest attempt), error (GitHub's answer) and status
// (its HTTP status, 0 without one). The entry goes when that tiddler's backup gets through. The file
// also keeps a pause of every backup, { until, count }, while there's one (queue.js), the last
// full backup (sync.js, queue.js): { id, startedAt, updatedAt, total, phase, steps, done, committed,
// removed, failed, finished }, and a note per big version being backed up (running: title ->
// { revision, size, started, attempt, sync }), written before the heavy part of a version over
// BIG_BACKUP_BYTES and cleared once the run is done with it: a run the runtime cuts short (the
// free plan's CPU time, on a version of several MB) runs nothing after the cut, the queue delivers
// it again three times the same way, then drops it, and the note is all that says why (design 1.7,
// 2.11). Written only when something changes, read only by a batch with a failure, a version that
// failed or waited before, or a big one, and by each step of a full backup. The admin wiki
// (src/browser/backup-alert.js) asks with its tiddler list request (X-Backup-Status: ask) when it
// loads, then hourly, at each request while an alert shows or a full backup runs, and shows an
// alert, and the full backup's progress in its control panel.

import { backupAlertMinutes, github } from "../settings.js";
import { BACKUP_STATUS_KEY } from "../storage.js";
import { backupRetryDelay, isRateLimit } from "./github.js";

// An entry not retried for a day belongs to a backup no longer waiting (one still waiting is retried
// at least every 6 hours: BACKUP_MAX_DELAY), and is dropped
const BACKUP_STATUS_STALE = 24 * 3600 * 1000;

// The queue's retry limit, which the worker can't read: Cloudflare's default (setup 2.3: leave it)
export const QUEUE_RETRIES = 3;

// A version this big gets a note before its backup's heavy part (queue.js, backupJob)
export const BIG_BACKUP_BYTES = 1024 * 1024;
// A note whose run was cut short: its last delivery (the queue's retries used up), or one left
// this long (a backup takes seconds; the queue's retries follow within minutes)
const RUNNING_STALE_MS = 15 * 60 * 1000;

export function backupFailure(job, e) {
  return { title: job.title, since: job.time || Date.now(), error: String(e.detail || e.message || e).slice(0, 200), status: e.status || 0 };
}

// { failing: title -> entry, pause, sync, running: title -> note }. strict: an R2 error throws,
// rather than reading as no file (a file that isn't JSON still reads as none)
export async function readBackupStatus(env, strict) {
  let data = null;
  try {
    const obj = await env.WIKI_BUCKET.get(BACKUP_STATUS_KEY);
    try {
      data = obj ? await obj.json() : null;
    } catch {}
  } catch (e) {
    if (strict) throw e;
  }
  const failing = data && typeof data.failing === "object" && data.failing ? Object.entries(data.failing) : [];
  const pause = data && data.pause && data.pause.until > 0 ? { until: data.pause.until, count: data.pause.count || 0 } : null;
  const sync = data && data.sync && typeof data.sync === "object" && typeof data.sync.id === "string" ? data.sync : null;
  const running = data && typeof data.running === "object" && data.running ? Object.entries(data.running).filter(([, n]) => n && typeof n === "object") : [];
  return { failing: new Map(failing), pause, sync, running: new Map(running) };
}

// Notes a big version's backup as under way, before its heavy part. Never throws: a note that can't
// be written mustn't fail the backup it's about
export async function noteRunning(env, note) {
  try {
    const status = await readBackupStatus(env, true);
    status.running.set(note.title, { revision: note.revision, size: note.size, started: note.started, attempt: note.attempt, ...(note.sync ? { sync: note.sync } : {}) });
    await writeBackupStatus(env, status);
  } catch (e) {
    console.error("[Backup] Could not note a big backup as under way:", e.message);
  }
}

// A full backup still going: started, not finished, and its last step not so long ago that it must
// have been lost (a message the queue dropped, say: a step takes seconds, pauses at most 6 hours)
export const SYNC_STALE_MS = 8 * 3600 * 1000;

export function syncRunning(sync) {
  return !!sync && !sync.finished && Date.now() - (sync.updatedAt || sync.startedAt || 0) < SYNC_STALE_MS;
}

// Records the full backup's state: patch merged into the stored one (or replacing it, if its id is
// another), with updatedAt now. stored: the status, if read already. Throws on an R2 error: a step
// that can't record its progress is retried (queue.js), the trigger answers 500.
export async function recordSync(env, patch, stored) {
  const status = stored || await readBackupStatus(env, true);
  const sync = status.sync && status.sync.id === patch.id ? { ...status.sync, ...patch } : { ...patch };
  sync.updatedAt = Date.now();
  await writeBackupStatus(env, { ...status, sync });
  return sync;
}

// failures: from backupFailure; cleared: titles whose backup got through; pause: { until, count } of
// a pause that starts, null when one is over, undefined when that's not known; stored: the status
// file, if this run has read it already; finished: titles noted as under way (noteRunning) that this
// run is done with, however it went. Never throws: an R2 error here mustn't count as a failed backup
export async function recordBackupResults(env, failures, cleared, pause, stored, finished = []) {
  try {
    await updateBackupStatus(env, failures, cleared, pause, stored, finished);
  } catch (e) {
    console.error("[Backup] Could not record how backups go:", e.message);
  }
}

async function updateBackupStatus(env, failures, cleared, pause, stored, finished) {
  const status = stored || await readBackupStatus(env, true), now = Date.now();
  const { failing, pause: storedPause, running } = status;
  let changed = false;
  for (const title of finished) changed = running.delete(title) || changed;
  for (const [title, note] of running) {
    // (A note left for a day belongs to a version no longer in the queue; also one with no time to go by)
    if (!(now - note.started <= BACKUP_STATUS_STALE)) changed = running.delete(title) || changed;
  }
  let keptPause = pause === undefined ? storedPause : pause;
  // (A pause over for a while no longer counts: gone)
  if (keptPause && now - keptPause.until >= PAUSE_CONTINUES) keptPause = null;
  if (JSON.stringify(keptPause) !== JSON.stringify(storedPause)) changed = true;
  for (const title of cleared) changed = failing.delete(title) || changed;
  for (const { title, since, error, status } of failures) {
    const entry = failing.get(title);
    failing.set(title, { since: entry ? Math.min(entry.since, since) : since, last: now, error, status });
    changed = true;
  }
  for (const [title, entry] of failing) {
    // (Also an entry that isn't one: no time to go by)
    if (!(now - entry.last <= BACKUP_STATUS_STALE)) changed = failing.delete(title) || changed;
  }
  if (!changed) return;
  await writeBackupStatus(env, { failing, pause: keptPause, sync: status.sync, running });
}

// The file as stored, or deleted when there's nothing to keep
async function writeBackupStatus(env, { failing, pause, sync, running }) {
  if (failing.size || pause || sync || (running && running.size)) {
    const status = { failing: Object.fromEntries(failing), ...(pause ? { pause } : {}), ...(sync ? { sync } : {}), ...(running && running.size ? { running: Object.fromEntries(running) } : {}) };
    await env.WIKI_BUCKET.put(BACKUP_STATUS_KEY, JSON.stringify(status), { httpMetadata: { contentType: "application/json" } });
  } else {
    await env.WIKI_BUCKET.delete(BACKUP_STATUS_KEY);
  }
}

// What the admin wiki is told: "off" (no backups: GITHUB_REPO or GITHUB_TOKEN missing), "ok", or
// encoded JSON with what there is to say: the backups failing for at least BACKUP_ALERT_MINUTES (60
// by default), as { count, title, since, error, status } of the oldest; a backup cut short (a note
// left behind by its last delivery, or for RUNNING_STALE_MS), as stuck: { count, title, size,
// attempts, started } of the oldest; the last full backup, as sync (running or finished); and
// backups: "off" when both apply to a worker without them
export function backupReport(env, { failing, sync, running }) {
  const after = backupAlertMinutes(env) * 60000;
  const now = Date.now();
  const due = [...failing].filter(([, e]) => now - e.last <= BACKUP_STATUS_STALE && now - e.since >= after).sort((a, b) => a[1].since - b[1].since);
  const cut = [...(running || [])].filter(([, n]) => now - n.started <= BACKUP_STATUS_STALE && (n.attempt > QUEUE_RETRIES || now - n.started >= RUNNING_STALE_MS)).sort((a, b) => a[1].started - b[1].started);
  const on = !!github(env);
  if (!due.length && !cut.length && !sync) return on ? "ok" : "off";
  const report = {};
  if (due.length) {
    const [title, e] = due[0];
    Object.assign(report, { count: due.length, title: title.slice(0, 200), since: e.since, error: e.error, status: e.status });
  }
  if (cut.length) {
    const [title, n] = cut[0];
    report.stuck = { count: cut.length, title: title.slice(0, 200), size: n.size, attempts: n.attempt, started: n.started };
  }
  if (sync) report.sync = { ...sync, running: syncRunning(sync) };
  if (!on) report.backups = "off";
  return encodeURIComponent(JSON.stringify(report));
}

// A pause of every backup: GitHub asked to slow down, or refuses every backup (a token it no longer
// accepts, say), so trying them one by one would only make more calls (each answered the same way)
// and more queue operations. While it lasts, the backups delivered are sent again to wait for its
// end, without calling GitHub; then the first one tries. If GitHub still refuses, the next pause is
// twice as long (up to BACKUP_MAX_DELAY, or as long as GitHub asks).
// A failure within this time after a pause ended: the next pause is twice as long
const PAUSE_CONTINUES = 3600 * 1000;

// The next pause of every backup, after a failure e: { until (ms), count (pauses in a row, from 0),
// error (GitHub's, from the call that started it), all (GitHub refuses every backup, not just asking
// to wait: the ones waiting are recorded as failing, for the alert) }. last: the pause before, if any.
// The consumer keeps the pause for the later runs in its isolate (queue.js); until and count are
// also kept in the status file, for a run in a new one.
export function nextPause(env, last, e) {
  const now = Date.now();
  // Still paused (a run that only knew from the status file): the same pause, for at least as long
  // as GitHub asks; just after one: twice as long; otherwise a first one
  const still = last && now < last.until;
  const count = !last ? 0 : still ? last.count : now - last.until < PAUSE_CONTINUES ? last.count + 1 : 0;
  const until = Math.max(now + backupRetryDelay(env, count, e.retryAfter) * 1000, still ? last.until : 0);
  return { until, count, error: e, all: !isRateLimit(e) };
}
