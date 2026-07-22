import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-runtime-live-bindings-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("ordinary ESM execution preserves mutable exports across importers", () => {
  const state = join(root, "state.mjs");
  const reader = join(root, "reader.mjs");
  const barrel = join(root, "barrel.mjs");
  const entry = join(root, "entry.mjs");

  writeFileSync(state, [
    'export let value = "initial";',
    "export function setValue(next) { value = next; }",
    "",
  ].join("\n"));
  writeFileSync(reader, [
    'import { value } from "./state.mjs";',
    "export function readValue() { return value; }",
    "",
  ].join("\n"));
  writeFileSync(barrel, [
    'export { value as reflected, setValue } from "./state.mjs";',
    'export * as stateNamespace from "./state.mjs";',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { reflected, setValue, stateNamespace } from "./barrel.mjs";',
    'import { readValue } from "./reader.mjs";',
    'if (readValue() !== "initial") throw new Error("missing initial value");',
    'if (reflected !== "initial") throw new Error("missing initial re-export");',
    'setValue("updated");',
    'if (readValue() !== "updated") throw new Error("stale imported value");',
    'if (reflected !== "updated") throw new Error("stale named re-export");',
    'if (stateNamespace.value !== "updated") throw new Error("stale namespace re-export");',
    'console.log("live-bindings-ok");',
    "",
  ].join("\n"));

  const child = Bun.spawnSync({
    cmd: [process.execPath, entry],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("live-bindings-ok\n");
  expect(child.stderr.toString()).toBe("");
});
