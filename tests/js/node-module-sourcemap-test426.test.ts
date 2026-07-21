import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const nodeTestRoot = join(
  import.meta.dir,
  "..",
  "..",
  "compat",
  "upstream",
  "node",
  "v24.11.1",
  "test",
);
const fixtureRoot = join(nodeTestRoot, "fixtures", "test426");
const spec = JSON.parse(readFileSync(join(fixtureRoot, "source-map-spec-tests.json"), "utf8"));
const status = JSON.parse(readFileSync(join(nodeTestRoot, "test426", "status", "source-map-spec-tests.json"), "utf8"));
const { SourceMap } = require("node:module");

for (const testSpec of spec.tests) {
  test(`SourceMap Test426: ${testSpec.name}`, () => {
    const payload = JSON.parse(
      readFileSync(join(fixtureRoot, "resources", testSpec.sourceMapFile), "utf8"),
    );
    let sourceMap;
    try {
      sourceMap = new SourceMap(payload);
    } catch {
      expect(testSpec.sourceMapIsValid).toBe(false);
      return;
    }

    for (const [index, action] of (testSpec.testActions ?? []).entries()) {
      if (action.actionType !== "checkMapping") continue;
      const actionStatus = status[testSpec.name]?.testActions;
      if (actionStatus?.skip || actionStatus?.[index]?.skip) continue;
      expect(sourceMap.findEntry(action.generatedLine, action.generatedColumn)).toMatchObject({
        originalSource: action.originalSource,
        originalLine: action.originalLine,
        originalColumn: action.originalColumn,
      });
    }
  });
}
