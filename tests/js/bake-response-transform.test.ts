import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "cottontail-bake-response-"));
const entry = path.join(root, "server-component.js");

writeFileSync(
  entry,
  `
    export const mode = "ssr";
    export function localResponse() {
      const Response = CustomResponse;
      return new Response();
    }
    export const globalResponse = new Response();
  `,
);

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("build --server-components enables Bake's Response transform", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "build", entry, "--target=bun", "--server-components"],
  });
  const output = result.stdout.toString();

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(output).toContain('import { Response } from "bun:app"');
  expect(output).toContain("return new CustomResponse");
  expect(output).toContain("new import_bun_app.Response");
});

test("build rejects server components with a browser target", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "build", entry, "--target=browser", "--server-components"],
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain(
    "Cannot use client-side --target=browser with --server-components",
  );
});
