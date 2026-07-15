(async () => {
console.log(Bun.pathToFileURL("~").href); import {promises} from "node:timers"; import p from "node:timers/promises"; console.log(promises===p)
})().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
