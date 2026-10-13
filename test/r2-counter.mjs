// Test-only wrapper around the built worker: the same worker, given an R2 bucket that records every
// call it makes ("get list", "put tiddler"...) and which calls ran at the same time, and that can make
// chosen calls fail. GET /__r2ops returns { calls, overlaps } since the last time and starts a new
// count; POST /__r2fail with { call: "put baked.html", times: 1 } makes the next such calls throw
// (or, with delay: milliseconds, makes them wait that long first). GET /__runs returns the R2 calls of
// each queue run since the last time, one list a run, and starts a new count. GET /__qops returns the
// queue operations since the last time, { sends, deliveries, acks, retries, maxAttempts (the most
// deliveries of one message), maxMessageBytes (the largest message sent, as JSON) }, and starts a new count:
// Cloudflare counts a send, a delivery and an ack as one operation each (a retry is the next delivery).
// POST /__qfail with { times } makes the next sends to the queue throw, as when it refuses them.
// Used by test/r2-ops.test.mjs, test/integrity.test.mjs and test/queue-backup.test.mjs; never deployed.
import worker from "../worker.js";

let calls = [];
let overlaps = [];          // "get list + head tiddler": a call that started while the others were running
let failures = [];          // { call, times, delay }: calls to make fail, or wait first
let runs = [];              // the R2 calls of each queue run
let qops = { sends: 0, deliveries: 0, acks: 0, retries: 0, maxAttempts: 0, maxMessageBytes: 0 };
let qfail = 0;              // sends left to refuse

// The queue binding, counting what's sent
function countedQueue(queue) {
  if (!queue) return queue;
  return {
    send(body, options) {
      if (qfail > 0) {
        qfail--;
        return Promise.reject(new Error("queue send refused (test)"));
      }
      qops.sends++;
      qops.maxMessageBytes = Math.max(qops.maxMessageBytes, JSON.stringify(body).length);
      return queue.send(body, options);
    },
    sendBatch(messages, options) { qops.sends += messages.length; return queue.sendBatch(messages, options); }
  };
}
const running = new Map();  // call -> how many are running

// What a key is, in the words the test uses
function kind(key) {
  if (key === "recipes/default/tiddlers.json") return "list";
  if (key.startsWith("recipes/default/tiddlers/")) return "tiddler";
  if (key === "_plugins/tiddlywikicore.js") return "core file";
  if (key.startsWith("_plugins/")) return "plugin file";
  if (key === "_page/shell.html") return "page shell";
  if (key.startsWith("_repair/")) return "repair";
  if (key === "_backup/status.json") return "backup status";
  if (key.startsWith("_backup/")) return "backup copy";
  if (key.startsWith("_app/")) return "app icon";
  return key;   // baked.html, index.html, status, manifest.webmanifest...
}

// run: where to record the calls of a queue run too
function counted(bucket, run) {
  return new Proxy(bucket, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      return (...args) => {
        if (!["get", "head", "put", "delete", "list"].includes(name)) return value.apply(target, args);
        const call = name === "list" ? "list tiddlers" : `${name} ${kind(Array.isArray(args[0]) ? args[0][0] : args[0])}`;
        calls.push(call);
        if (run) run.push(call);
        const failure = failures.find(f => f.call === call && f.times > 0);
        if (failure) {
          failure.times--;
          if (failure.delay) return new Promise(r => setTimeout(r, failure.delay)).then(() => value.apply(target, args));
          return Promise.reject(new Error(`R2 ${call} failed (test)`));
        }
        if (running.size > 0) overlaps.push([...running.keys(), call].sort().join(" + "));
        running.set(call, (running.get(call) || 0) + 1);
        const done = () => running.get(call) > 1 ? running.set(call, running.get(call) - 1) : running.delete(call);
        const result = value.apply(target, args);
        Promise.resolve(result).then(done, done);
        return result;
      };
    }
  });
}

let batchInProgress = Promise.resolve();

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__r2fail") {
      const { call, times = 1, delay = 0 } = await request.json();
      failures.push({ call, times, delay });
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__qfail") {
      qfail = (await request.json()).times || 1;
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__qops") {
      const out = qops;
      qops = { sends: 0, deliveries: 0, acks: 0, retries: 0, maxAttempts: 0, maxMessageBytes: 0 };
      return Response.json(out);
    }
    if (new URL(request.url).pathname === "/__runs") {
      const out = runs;
      runs = [];
      return Response.json(out);
    }
    if (new URL(request.url).pathname === "/__r2ops") {
      const out = { calls, overlaps };
      calls = [];
      overlaps = [];
      return Response.json(out);
    }
    return worker.fetch(request, { ...env, WIKI_BUCKET: counted(env.WIKI_BUCKET), BACKUP_QUEUE: countedQueue(env.BACKUP_QUEUE) }, ctx);
  },
  // Batches one at a time, as wrangler.toml's max_concurrency = 1 has it on Cloudflare: Miniflare
  // has no such setting, and dispatches a second batch while one is in flight once the backlog
  // fills (a bulk import on a slow machine), which the suite's "commits never overlapped" check
  // would then blame on the worker.
  async queue(batch, env, ctx) {
    const previous = batchInProgress;
    let done;
    batchInProgress = new Promise(resolve => { done = resolve; });
    try {
      await previous;
      return await this.queueOne(batch, env, ctx);
    } finally {
      done();
    }
  },
  async queueOne(batch, env, ctx) {
    const run = [];
    runs.push(run);
    qops.deliveries += batch.messages.length;
    for (const m of batch.messages) qops.maxAttempts = Math.max(qops.maxAttempts, m.attempts || 0);
    // The messages, counting acks and retries (attempts and timestamp read through)
    const messages = batch.messages.map(m => ({
      get id() { return m.id; }, get body() { return m.body; }, get attempts() { return m.attempts; }, get timestamp() { return m.timestamp; },
      ack() { qops.acks++; return m.ack(); },
      retry(options) { qops.retries++; return m.retry(options); }
    }));
    return worker.queue({ queue: batch.queue, messages, ackAll: () => batch.ackAll(), retryAll: o => batch.retryAll(o) },
      { ...env, WIKI_BUCKET: counted(env.WIKI_BUCKET, run), BACKUP_QUEUE: countedQueue(env.BACKUP_QUEUE) }, ctx);
  }
};
