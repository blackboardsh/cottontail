import { workerData, parentPort } from "node:worker_threads";
import { writeFileSync } from "node:fs";

for (let iteration = 0; iteration < 12; iteration++) {
  const expected = `worker-${workerData.index}-build-${iteration}`;
  writeFileSync(workerData.entry, `export const value = ${JSON.stringify(expected)};`);
  const result = await Bun.build({ entrypoints: [workerData.entry], target: "bun" });
  if (!result.success || result.outputs.length !== 1 ||
      !(await result.outputs[0].text()).includes(expected)) {
    throw new Error("Concurrent build output was lost or mixed between workers");
  }
}
parentPort.postMessage("done");
