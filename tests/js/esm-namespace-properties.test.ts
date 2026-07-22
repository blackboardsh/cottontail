import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const root = mkdtempSync(join(tmpdir(), "cottontail-esm-namespace-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("required ESM namespaces keep Bun's virtual marker out of export enumeration", async () => {
  const nodes = join(root, "nodes.js");
  const config = join(root, "config.js");
  writeFileSync(nodes, [
    "export const Alpha = { structure: [] };",
    "export const Beta = { structure: [] };",
    "",
  ].join("\n"));
  writeFileSync(config, [
    'import * as node from "./nodes.js";',
    "export default { node };",
    "",
  ].join("\n"));

  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort } = require("node:worker_threads");
      const config = require(${JSON.stringify(config)});
      const node = config.default.node;
      const configPrototype = Object.getPrototypeOf(config);
      parentPort.postMessage({
        configKeys: Object.keys(config),
        configTag: Object.prototype.toString.call(config),
        configPrototypeKeys: Reflect.ownKeys(configPrototype).map(String),
        configPrototypeParentIsNull: Object.getPrototypeOf(configPrototype) === null,
        configMarker: config.__esModule,
        configMarkerIn: "__esModule" in config,
        configMarkerOwn: Object.hasOwn(config, "__esModule"),
        configMarkerDescriptor: Object.getOwnPropertyDescriptor(config, "__esModule") !== undefined,
        nodeKeys: Object.keys(node).sort(),
        nodeHasDefault: Object.hasOwn(node, "default"),
        nodeMarkerIn: "__esModule" in node,
        nodeMarkerOwn: Object.hasOwn(node, "__esModule"),
        nodeMarkerDescriptor: Object.getOwnPropertyDescriptor(node, "__esModule") !== undefined,
      });
    `, { eval: true });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

  expect(result).toEqual({
    configKeys: ["default"],
    configTag: "[object Module]",
    configPrototypeKeys: ["__esModule"],
    configPrototypeParentIsNull: true,
    configMarker: true,
    configMarkerIn: true,
    configMarkerOwn: false,
    configMarkerDescriptor: false,
    nodeKeys: ["Alpha", "Beta"],
    nodeHasDefault: false,
    nodeMarkerIn: true,
    nodeMarkerOwn: false,
    nodeMarkerDescriptor: false,
  });
});
