// Runs test suites one after the other and reports every failure, not only the first: each suite's
// output goes to the terminal and to test-results/<suite>.log, a failing suite doesn't stop the
// next, and the summary names what failed. Exits 1 if any suite failed.
// Usage: node tools/run-suites.mjs <suite>...   (a suite is test/<suite>.test.mjs)
// A browser suite that fails leaves the requests its pages made and a Playwright trace of each
// browser context under test-results/ too (test/browser-harness.mjs). On GitHub, a failed job
// uploads test-results/ (ci.yml). Design 2.24.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RESULTS = path.join(ROOT, "test-results");
const suites = process.argv.slice(2);
if (suites.length === 0) {
  console.error("Usage: node tools/run-suites.mjs <suite>...   (test/<suite>.test.mjs)");
  process.exit(2);
}
mkdirSync(RESULTS, { recursive: true });

function run(suite) {
  return new Promise(resolve => {
    const file = path.join(ROOT, "test", `${suite}.test.mjs`);
    if (!existsSync(file)) return resolve({ suite, ok: false, seconds: 0, note: "no such suite" });
    const log = createWriteStream(path.join(RESULTS, `${suite}.log`));
    const started = Date.now();
    console.log(`\n=== ${suite} ===`);
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let summary = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", chunk => {
        process.stdout.write(chunk);
        log.write(chunk);
        const m = String(chunk).match(/(\d+)\/(\d+) passed[^\n]*/g);
        if (m) summary = m[m.length - 1];
      });
    }
    child.on("close", code => {
      log.end();
      resolve({ suite, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000), note: summary || (code === 0 ? "" : `exit ${code}`) });
    });
  });
}

const results = [];
for (const suite of suites) results.push(await run(suite));
const failed = results.filter(r => !r.ok);
console.log("\n=== Summary ===");
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.suite.padEnd(14)} ${String(r.seconds).padStart(4)} s  ${r.note}`);
console.log(failed.length ? `\n${failed.length} of ${results.length} suites failed: ${failed.map(r => r.suite).join(", ")} (logs in test-results/)` : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);
