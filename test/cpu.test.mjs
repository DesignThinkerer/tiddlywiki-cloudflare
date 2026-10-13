// CPU of the worker's heaviest steps, against a budget. A Worker on the free plan gets about 10 ms of
// CPU a request: a save of a big plugin must not parse or decode its text, and its backup must not
// turn it into strings. Measured in Node, which runs the same V8 as Workers, on the built worker's own
// functions, for a 4.8 MB plugin. Each budget is relative to JSON.parse of the same bytes on this
// machine (what the worker avoids), so it holds on a faster or slower one.
// Run: npm run test:cpu
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));
// worker.js keeps these to itself: a copy that exports them
const copy = path.join(os.tmpdir(), `worker-cpu-${process.pid}.mjs`);
fs.writeFileSync(copy, fs.readFileSync(WORKER, "utf8") + "\nexport { readSave, backupJob };\n");
const { readSave, backupJob } = await import(pathToFileURL(copy).href);
fs.unlinkSync(copy);

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const encoder = new TextEncoder(), decoder = new TextDecoder();
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
// The least CPU of several runs, in ms (the others had something else in the way)
async function measure(fn, runs = 15) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = cpu();
    await fn();
    best = Math.min(best, cpu() - t);
  }
  return best;
}

// A plugin as the browser module sends it: flat, its text (the plugin's JSON, as a string) last
const TITLE = "$:/plugins/test/big";
const code = 'function x(a, b) { return {"k": a, "v": [b, "y"]}; } // é, done\n';
const pluginText = JSON.stringify({ tiddlers: { [TITLE + "/code"]: { type: "application/javascript", text: code.repeat(Math.ceil(3.6e6 / code.length)) } } });
const body = encoder.encode(JSON.stringify({ title: TITLE, "plugin-type": "plugin", type: "application/json", version: "1.0.0", text: pluginText }));
const size = `${(body.length / 1e6).toFixed(1)} MB`;
const reference = await measure(() => JSON.parse(decoder.decode(body)));
const ratio = ms => `${ms.toFixed(2)} ms, ${(ms / reference).toFixed(2)}× JSON.parse (${reference.toFixed(2)} ms)`;

// 1. Reading a save: only the fields before the text are parsed
const saveCpu = await measure(() => readSave(new Request("http://admin/recipes/default/tiddlers/x", {
  method: "PUT", headers: { "Content-Type": "application/json", "X-Tiddler-Layout": "flat" }, body
})));
const save = await readSave(new Request("http://admin/", { method: "PUT", headers: { "X-Tiddler-Layout": "flat" }, body }));
check(`reading a save of a ${size} plugin doesn't parse its text: at most 0.25× JSON.parse of it`,
  save.fields.title === TITLE && save.fields.text === undefined && saveCpu <= 0.25 * reference, ratio(saveCpu));

// 2. Its backup, from its R2 copy: the git hash and the base64 worked out on bytes, the request
// body made as bytes (through strings it took about 6× JSON.parse)
const stored = save.stored("1791000000000");
const object = bytes => ({
  size: bytes.length, etag: "e", customMetadata: { revision: "1791000000000", layout: "flat" }, httpMetadata: {}, uploaded: new Date(),
  text: async () => decoder.decode(bytes), json: async () => JSON.parse(decoder.decode(bytes)),
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
});
const r2 = new Map([["_backup/versions/big", stored], ["recipes/default/tiddlers/" + TITLE, stored]]);
const env = { GITHUB_REPO: "o/r", GITHUB_TOKEN: "t", WIKI_BUCKET: { head: async k => r2.has(k) ? object(r2.get(k)) : null, get: async k => r2.has(k) ? object(r2.get(k)) : null } };
let sentBytes = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (init.method === "GET") return new Response(JSON.stringify({ sha: "0".repeat(40) }));   // another version on GitHub
  const sent = typeof init.body === "string" ? encoder.encode(init.body) : init.body;   // (what sending a string costs)
  sentBytes = sent.length;
  return new Response('{"content":{"sha":"1111111111111111111111111111111111111111"}}');
};
const job = () => ({ action: "save", title: TITLE, revision: "1791000000000", time: 1, tries: 0, contentKey: "_backup/versions/big" });
const backupCpu = await measure(() => backupJob(env, job()));
globalThis.fetch = realFetch;
check(`backing up a ${size} plugin from its R2 copy: at most 2.5× JSON.parse of it`,
  sentBytes > stored.length && backupCpu <= 2.5 * reference, `${ratio(backupCpu)}, request ${(sentBytes / 1e6).toFixed(1)} MB`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
