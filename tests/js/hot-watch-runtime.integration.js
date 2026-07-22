import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const binary = join(root, "zig-out", "bin", process.platform === "win32" ? "cottontail.exe" : "cottontail");
if (!existsSync(binary)) throw new Error(`missing built binary: ${binary}`);

const directory = mkdtempSync(join(tmpdir(), "cottontail-hot-watch-"));
const entrypoint = join(directory, "entry.mjs");
const dependency = join(directory, "dependency.mjs");
const unrelated = join(directory, "unrelated.txt");

const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once("error", reject);
  portProbe.listen(0, "127.0.0.1", resolve);
});
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));

writeFileSync(entrypoint, [
  'import { value } from "./dependency.mjs";',
  `Bun.serve({ port: ${port}, fetch() { return new Response("ok"); } });`,
  "globalThis.reloadCounter = (globalThis.reloadCounter ?? 0) + 1;",
  'console.log(`generation:${value}:${globalThis.reloadCounter}`);',
  "setInterval(() => {}, 60_000);",
  "",
].join("\n"));
writeFileSync(dependency, "export const value = 1;\n");

function start(mode, extraExecArgs = []) {
  const child = spawn(binary, [mode, "--no-clear-screen", ...extraExecArgs, entrypoint], {
    cwd: directory,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", chunk => { output.stdout += chunk; });
  child.stderr.on("data", chunk => { output.stderr += chunk; });
  return { child, output };
}

function waitFor(session, stream, text, from = 0, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const index = session.output[stream].indexOf(text, from);
      if (index >= 0) return resolve(index + text.length);
      if (session.child.exitCode != null) {
        return reject(new Error(`${stream} never contained ${JSON.stringify(text)}; process exited ${session.child.exitCode}\n${session.output.stderr}`));
      }
      if (Date.now() - started >= timeoutMs) {
        return reject(new Error(`timed out waiting for ${JSON.stringify(text)} in ${stream}\nstdout:\n${session.output.stdout}\nstderr:\n${session.output.stderr}`));
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function stop(session) {
  if (session.child.exitCode != null || session.child.signalCode != null) return Promise.resolve();
  session.child.kill("SIGTERM");
  return new Promise(resolve => {
    const force = setTimeout(() => session.child.kill("SIGKILL"), 2_000);
    session.child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

async function assertNoGeneration(session, count, durationMs = 350) {
  await new Promise(resolve => setTimeout(resolve, durationMs));
  const matches = session.output.stdout.match(/generation:/g) ?? [];
  if (matches.length !== count) {
    throw new Error(`unexpected reload count ${matches.length}, expected ${count}\n${session.output.stdout}`);
  }
}

let hot;
let watch;
let inspectorHot;
try {
  hot = start("--hot");
  let cursor = await waitFor(hot, "stdout", "generation:1:1");
  writeFileSync(unrelated, "ignored\n");
  await assertNoGeneration(hot, 1);

  writeFileSync(dependency, "export const value = 2;\n");
  cursor = await waitFor(hot, "stdout", "generation:2:2", cursor);

  writeFileSync(dependency, "export const value = ;\n");
  const errorCursor = await waitFor(hot, "stderr", "error:");
  await new Promise(resolve => setTimeout(resolve, 100));
  writeFileSync(dependency, "export const value = 3;\n");
  await waitFor(hot, "stdout", "generation:3:3", cursor);
  if (errorCursor <= 0) throw new Error("expected a recoverable build diagnostic");
  await stop(hot);

  watch = start("--watch");
  cursor = await waitFor(watch, "stdout", "generation:3:1");
  const replacement = join(directory, "dependency.next.mjs");
  writeFileSync(replacement, "export const value = 4;\n");
  renameSync(replacement, dependency);
  await waitFor(watch, "stdout", "generation:4:1", cursor);
  await stop(watch);

  inspectorHot = start("--hot", ["--inspect=0"]);
  cursor = await waitFor(inspectorHot, "stdout", "generation:4:1");
  await waitFor(inspectorHot, "stderr", "Listening:\n  ws://");
  writeFileSync(dependency, "export const value = 5;\n");
  await waitFor(inspectorHot, "stdout", "generation:5:2", cursor);
  if ((inspectorHot.output.stderr.match(/Listening:/g) ?? []).length !== 1) {
    throw new Error(`hot reload restarted inspector transport\n${inspectorHot.output.stderr}`);
  }
  await stop(inspectorHot);

  console.log("hot/watch runtime integration passed");
} finally {
  await Promise.all([hot && stop(hot), watch && stop(watch), inspectorHot && stop(inspectorHot)].filter(Boolean));
  rmSync(directory, { recursive: true, force: true });
}
