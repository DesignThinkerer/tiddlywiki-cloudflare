// Test-only wrapper around the built worker: the same worker, given an R2 bucket that records every
// call it makes ("get list", "put tiddler"...) and which calls ran at the same time. GET /__r2ops
// returns { calls, overlaps } since the last time and starts a new count. Used by
// test/r2-ops.test.mjs; never deployed.
import worker from "../worker.js";

let calls = [];
let overlaps = [];          // "get list + head tiddler": a call that started while the others were running
const running = new Map();  // call -> how many are running

// What a key is, in the words the test uses
function kind(key) {
  if (key === "recipes/default/tiddlers.json") return "list";
  if (key.startsWith("recipes/default/tiddlers/")) return "tiddler";
  if (key.startsWith("_plugins/")) return "plugin file";
  if (key.startsWith("_repair/")) return "repair";
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
