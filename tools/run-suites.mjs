// Runs test suites and reports every failure, not only the first: each suite's output goes to the
// terminal and to test-results/<suite>.log, a failing suite doesn't stop the next, and the summary
// names what failed. Exits 1 if any suite failed.
// Usage: node tools/run-suites.mjs [--parallel <n>] <suite>...   (a suite is test/<suite>.test.mjs)
// --parallel <n> runs n suites at once (1 by default: one after the other, as CI runs them). Every
// suite takes free ports and its own temporary folder, and writes its own files under test-results/,
// so they can share a machine; what they share is its CPU, and a timing check that passes alone can
// fail with too many at once (README 6). With several at once, a suite's output is printed whole
// when it ends, so the outputs don't interleave; its log is written as it goes.
// A browser suite that fails leaves the requests its pages made and a Playwright trace of each
// browser context under test-results/ too (test/browser-harness.mjs). On GitHub, a failed job
// uploads test-results/ (ci.yml). Design 2.24.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESULTS = path.join(ROOT, "test-results");
const USAGE = "Usage: node tools/run-suites.mjs [--parallel <n>] <suite>...   (test/<suite>.test.mjs; --parallel <n>: n suites at once, 1 by default)";

const suites = [];
let parallel = 1;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = arg.startsWith("--parallel=") ? arg.slice("--parallel=".length) : arg === "--parallel" ? args[++i] : null;
  if (value === null) {
    suites.push(arg);
    continue;
  }
  parallel = Number(value);
  if (!Number.isInteger(parallel) || parallel < 1) {
    console.error(`--parallel takes a whole number of suites to run at once, 1 or more; got ${JSON.stringify(value)}.\n${USAGE}`);
    process.exit(2);
  }
}
if (suites.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
mkdirSync(RESULTS, { recursive: true });

// Runs one suite; live: its output to the terminal as it comes (otherwise, in one piece at the end)
function run(suite, live) {
  return new Promise(resolve => {
    const file = path.join(ROOT, "test", `${suite}.test.mjs`);
    if (!existsSync(file)) {
      console.log(`\n=== ${suite} ===\nno such suite: ${path.relative(ROOT, file)}`);
      return resolve({ suite, ok: false, seconds: 0, note: "no such suite" });
    }
    const log = createWriteStream(path.join(RESULTS, `${suite}.log`));
    const started = Date.now();
    const chunks = [];
    if (live) console.log(`\n=== ${suite} ===`);
    else console.log(`started ${suite}`);
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let summary = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", chunk => {
        if (live) process.stdout.write(chunk);
        else chunks.push(chunk);
        log.write(chunk);
        const m = String(chunk).match(/(\d+)\/(\d+) passed[^\n]*/g);
        if (m) summary = m[m.length - 1];
      });
    }
    child.on("close", code => {
      log.end();
      if (!live) process.stdout.write(`\n=== ${suite} ===\n${Buffer.concat(chunks)}`);
      resolve({ suite, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000), note: summary || (code === 0 ? "" : `exit ${code}`) });
    });
  });
}

// The suites in the order given, parallel at a time (each worker takes the next one as it finishes)
const results = new Array(suites.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(parallel, suites.length) }, async () => {
  while (next < suites.length) {
    const i = next++;
    results[i] = await run(suites[i], parallel === 1);
  }
}));
const failed = results.filter(r => !r.ok);
console.log("\n=== Summary ===");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.suite.padEnd(14)} ${String(r.seconds).padStart(4)} s  ${r.note}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed: ${failed.map(r => r.suite).join(", ")} (logs in test-results/)` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
