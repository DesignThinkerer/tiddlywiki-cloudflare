// Test-only wrapper around the built worker: the same worker, given an R2 bucket that records every
// call it makes ("get list", "put tiddler"...). GET /__r2ops returns the calls since the last time
// and starts a new count. Used by test/r2-ops.test.mjs; never deployed.
import worker from "../worker.js";

let calls = [];

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
        if (["get", "head", "put", "delete", "list"].includes(name)) {
          calls.push(name === "list" ? "list tiddlers" : `${name} ${kind(Array.isArray(args[0]) ? args[0][0] : args[0])}`);
        }
        return value.apply(target, args);
      };
    }
  });
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__r2ops") {
      const out = calls;
      calls = [];
      return Response.json(out);
    }
    return worker.fetch(request, { ...env, WIKI_BUCKET: counted(env.WIKI_BUCKET) }, ctx);
  },
  async queue(batch, env, ctx) {
    return worker.queue(batch, { ...env, WIKI_BUCKET: counted(env.WIKI_BUCKET) }, ctx);
  }
};
