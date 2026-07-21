import { expect, test } from "bun:test";

function parseBakeArtifact(source: string) {
  const registryStart = source.indexOf("\n  // ", 8);
  expect(registryStart).toBeGreaterThan(0);
  const factory = (0, eval)(source.slice(0, registryStart));
  const registrySource = source.slice(registryStart);
  const invocationEnd = registrySource.lastIndexOf(");");
  const [modules, config] = (0, eval)(`[{${registrySource.slice(0, invocationEnd)}]`);
  return { factory, modules, config };
}

function dependencyIds(definition: any) {
  const encoded = definition[0];
  const ids: string[] = [];
  for (let index = 0; index < encoded.length;) {
    ids.push(encoded[index]);
    index += 2 + encoded[index + 1];
  }
  return ids;
}

function definitionSignature(value: any) {
  return JSON.stringify(value, (_key, item) => typeof item === "function" ? item.toString() : item);
}

test("Bake HMR runtime preserves unchanged server module state", async () => {
  const root = "/tmp/cottontail-bake-hmr-runtime";
  const entry = `${root}/entry.ts`;
  const baseFiles = {
    [`${root}/server.ts`]: `
      export function render(request, metadata) {
        return metadata.pageModule.default(request, metadata);
      }
    `,
    [`${root}/state.ts`]: `
      export let value = 0;
      export function increment() { value++; }
    `,
  };
  const build = async (label: string) => {
    const result = await Bun.build({
      entrypoints: [entry],
      files: {
        ...baseFiles,
        [`${root}/page.ts`]: `
          import { value, increment } from "./state.ts";
          export default function page() {
            increment();
            return new Response(${JSON.stringify(label)} + ": " + value);
          }
        `,
        [entry]: `
          import * as server from "./server.ts";
          import * as page from "./page.ts";
          export const modules = [server, page];
        `,
      },
      format: "internal_bake_dev",
      target: "bun",
      throw: false,
    });
    expect(result.logs.map(log => log.message)).toEqual([]);
    expect(result.success).toBe(true);
    return parseBakeArtifact(await result.outputs[0].text());
  };

  const initial = await build("State");
  const runtime = initial.factory(false, {
    require: globalThis.require,
    resolve: (specifier: string) => specifier,
    bakeBuiltin: (specifier: string) => globalThis.require(specifier),
  });
  await runtime.registerUpdate(initial.modules, null, null);
  const [serverId, pageId] = dependencyIds(initial.modules[initial.config.main]);
  const dispatch = () => runtime.handleRequest(
    new Request("http://localhost/"),
    serverId,
    [pageId],
    "",
    [],
    null,
    () => {},
    () => { throw new Error("unexpected route transition"); },
    () => { throw new Error("unexpected route transition"); },
  );

  expect(await (await dispatch()).text()).toBe("State: 1");
  expect(await (await dispatch()).text()).toBe("State: 2");
  expect(await (await dispatch()).text()).toBe("State: 3");

  const updated = await build("Value");
  const changed = {};
  for (const [id, definition] of Object.entries(updated.modules)) {
    if (definitionSignature(definition) !== definitionSignature(initial.modules[id])) changed[id] = definition;
  }
  await runtime.registerUpdate(changed, null, null);
  expect(await (await dispatch()).text()).toBe("Value: 4");
});
