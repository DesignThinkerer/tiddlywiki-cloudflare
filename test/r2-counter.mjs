// Test-only wrapper around the built worker: the same worker, given an R2 bucket that records every
// call it makes ("get list", "put tiddler"...) and which calls ran at the same time, and that can make
// chosen calls fail. GET /__r2ops returns { calls, overlaps } since the last time and starts a new
// count; POST /__r2fail with { call: "put baked.html", times: 1 } makes the next such calls throw
// (or, with delay: milliseconds, makes them wait that long first).
// Used by test/r2-ops.test.mjs, test/integrity.test.mjs and test/queue-backup.test.mjs; never deployed.
import worker from "../worker.js";

let calls = [];
let overlaps = [];          // "get list + head tiddler": a call that started while the others were running
let failures = [];          // { call, times, delay }: calls to make fail, or wait first
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
  return key;   // baked.html, index.html, status...
}

function counted(bucket) {
  return new Proxy(bucket, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function") return value;
      return (...args) => {
        if (!["get", "head", "put", "delete", "list"].includes(name)) return value.apply(target, args);
        const call = name === "list" ? "list tiddlers" : `${name} ${kind(Array.isArray(args[0]) ? args[0][0] : args[0])}`;
        calls.push(call);
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

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__r2fail") {
      const { call, times = 1, delay = 0 } = await request.json();
      failures.push({ call, times, delay });
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === "/__r2ops") {
      const out = { calls, overlaps };
      calls = [];
      overlaps = [];
      return Response.json(out);
    }
    return worker.fetch(request, { ...env, WIKI_BUCKET: counted(env.WIKI_BUCKET) }, ctx);
  },
  async queue(batch, env, ctx) {
    return worker.queue(batch, { ...env, WIKI_BUCKET: counted(env.WIKI_BUCKET) }, ctx);
  }
};
