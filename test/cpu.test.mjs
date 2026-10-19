// CPU of the worker's heaviest steps, against a budget. A Worker on the free plan gets about 10 ms of
// CPU a request: a save of a big plugin must not parse or decode its text, and its backup must not
// turn it into strings. Measured in Node, which runs the same V8 as Workers, on the built worker's own
// functions, for a 4.8 MB plugin. Each budget is relative to JSON.parse of the same bytes on this
// machine (what the worker avoids), so it holds on a faster or slower one.
// Run: npm run test:cpu
import { Miniflare } from "miniflare";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKER = fileURLToPath(new URL("../worker.js", import.meta.url));
// worker.js keeps these to itself: a copy that exports them
const copy = path.join(os.tmpdir(), `worker-cpu-${process.pid}.mjs`);
const workerText = fs.readFileSync(WORKER, "utf8");
fs.writeFileSync(copy, workerText + "\nexport { readSave, backupJob, updateList };\n");
const { readSave, backupJob, updateList } = await import(pathToFileURL(copy).href);
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

// 3. A save's list update: the whole tiddler list read, changed and written again (limits 5 calls it
// a save's largest cost, about 1 ms per 400–500 tiddlers), for a wiki of 2,000 tiddlers
const LIST_KEY = "recipes/default/tiddlers.json";
const entries = Array.from({ length: 2000 }, (_, i) => ({
  title: `Tiddler ${i}`, tags: ["one", "two words"], type: "text/vnd.tiddlywiki", modified: "20261013120000000", created: "20261013120000000",
  bag: "default", recipe: "default", revision: String(1791000000000 + i), color: "red", caption: `Caption of tiddler ${i}`, _is_skinny: ""
}));
const listBytes = encoder.encode(JSON.stringify(entries));
const listReference = await measure(() => JSON.parse(decoder.decode(listBytes)));
const listEnv = { WIKI_BUCKET: {
  get: async k => k === LIST_KEY ? { etag: "list-1", httpEtag: '"list-1"', text: async () => decoder.decode(listBytes) } : null,
  put: async () => ({ etag: "list-2", httpEtag: '"list-2"' }),
  head: async () => null
} };
const listCpu = await measure(() => updateList(listEnv, {}, "Tiddler 1000", { title: "Tiddler 1000", tags: ["one"], text: "changed" }, "1791000099999"));
check(`a save's list update for a wiki of ${entries.length} tiddlers (${Math.round(listBytes.length / 1e3)} KB): at most 3× JSON.parse of the list`,
  listCpu <= 3 * listReference, `${listCpu.toFixed(2)} ms, ${(listCpu / listReference).toFixed(2)}× JSON.parse (${listReference.toFixed(2)} ms); ${Math.round(entries.length / listCpu)} tiddlers per ms of CPU`);

// 4. In the Cloudflare runtime itself (Miniflare's workerd), the request body of a backup: its base64
// made by the runtime's own encoder (Uint8Array.prototype.toBase64, native), not the JavaScript loop
// the worker keeps for a runtime without it (Node 22, where the checks above measure). Timed from
// outside, workerd's clock not advancing during computation; the loop (a copy of the worker's, here,
// as the reference) and the body-maker in the same isolate, in turns, the best of several, so the
// machine's speed and load fall out of the ratio. And the same bytes either way, around the slice
// boundaries and the paddings.
const BENCH = `
import { githubContents } from "./worker.mjs";
const encoder = new TextEncoder();
// The JavaScript loop, as the worker has it for a runtime without the native encoder
const DIGITS = encoder.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/");
function loopBase64(bytes, out, at) {
  const end = bytes.length - bytes.length % 3;
  let i = 0;
  for (; i < end; i += 3) {
    const v = bytes[i] << 16 | bytes[i + 1] << 8 | bytes[i + 2];
    out[at] = DIGITS[v >>> 18]; out[at + 1] = DIGITS[v >>> 12 & 63]; out[at + 2] = DIGITS[v >>> 6 & 63]; out[at + 3] = DIGITS[v & 63];
    at += 4;
  }
  if (i < bytes.length) {
    const two = i + 1 < bytes.length, v = bytes[i] << 16 | (two ? bytes[i + 1] << 8 : 0);
    out[at] = DIGITS[v >>> 18]; out[at + 1] = DIGITS[v >>> 12 & 63]; out[at + 2] = two ? DIGITS[v >>> 6 & 63] : 61; out[at + 3] = 61;
    at += 4;
  }
  return at;
}
const inputs = new Map();
function input(n) {
  if (!inputs.has(n)) { const b = new Uint8Array(n); let x = 123456789; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 255; } inputs.set(n, b); }
  return inputs.get(n);
}
let body = null;
globalThis.fetch = async (url, init) => { body = init.body; return new Response('{"content":{"sha":"1111111111111111111111111111111111111111"}}'); };
const github = githubContents({ GITHUB_REPO: "o/r", GITHUB_TOKEN: "t" }, { bytes: 0, calls: 0 });
// The body as the loop alone would make it (github.put's head and tail around it)
function byLoop(bytes) {
  const head = encoder.encode('{"message":"m","branch":"main","content":"');
  const out = new Uint8Array(head.length + Math.ceil(bytes.length / 3) * 4 + 2);
  out.set(head); const end = loopBase64(bytes, out, head.length); out[end] = 34; out[end + 1] = 125; return out;
}
export default { async fetch(req) {
  const url = new URL(req.url), n = Number(url.searchParams.get("n")), times = Number(url.searchParams.get("times") || 1);
  if (url.pathname === "/same") {
    await github.put("T", input(n), "m", null);
    const expected = byLoop(input(n));
    let same = body.length === expected.length;
    for (let i = 0; same && i < body.length; i++) same = body[i] === expected[i];
    return Response.json({ same, length: body.length, expected: expected.length, native: typeof Uint8Array.prototype.toBase64 });
  }
  const bytes = input(n);
  if (url.pathname === "/put") for (let i = 0; i < times; i++) await github.put("T", bytes, "m", null);
  else if (url.pathname === "/loop") for (let i = 0; i < times; i++) byLoop(bytes);
  return new Response("ok");
} }
`;
const mf = new Miniflare({
  modules: [{ type: "ESModule", path: "bench.mjs", contents: BENCH }, { type: "ESModule", path: "worker.mjs", contents: workerText + "\nexport { githubContents };\n" }],
  compatibilityDate: "2024-09-23"
});
const ask = async (route, n, times = 1) => {
  const started = process.hrtime.bigint();
  const res = await mf.dispatchFetch(`http://cpu/${route}?n=${n}&times=${times}`);
  const text = await res.text();
  if (res.status !== 200) throw new Error(`${route}: ${res.status} ${text.slice(0, 200)}`);
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, text };
};
const sameCases = [];
for (const n of [0, 1, 2, 3, 4, 5, 3e6 - 1, 3e6, 3e6 + 1, 6e6 + 2, body.length]) {
  const r = JSON.parse((await ask("same", n)).text);
  if (!r.same) sameCases.push(`${n}: ${r.length} bytes, expected ${r.expected}`);
}
check("in the Cloudflare runtime, the backup's request body is the same bytes as the loop's, for 0 to 5 bytes, around the 3 MB slices, and the plugin",
  sameCases.length === 0, sameCases.join("; "));
for (const route of ["loop", "put"]) await ask(route, body.length, 2);   // (warm-up: the loop's JIT, the first request)
let bestLoop = Infinity, bestPut = Infinity;
for (let round = 0; round < 5; round++) {
  bestLoop = Math.min(bestLoop, (await ask("loop", body.length, 5)).ms);
  bestPut = Math.min(bestPut, (await ask("put", body.length, 5)).ms);
}
const native = JSON.parse((await ask("same", 3)).text).native === "function";
check(`in the Cloudflare runtime, the body of a ${size} plugin's backup is made with its native base64: at most 0.7× the JavaScript loop's time`,
  native && bestPut <= 0.7 * bestLoop, `${(bestPut / 5).toFixed(2)} ms against the loop's ${(bestLoop / 5).toFixed(2)} ms, ${(bestPut / bestLoop).toFixed(2)}× (toBase64 ${native ? "present" : "absent"})`);
await mf.dispose();

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
