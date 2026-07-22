import { ok, strictEqual } from "node:assert/strict";
import { createRequire } from "node:module";
import * as inspector from "node:inspector";
import * as inspectorPromises from "node:inspector/promises";

const require = createRequire(import.meta.url);
const requiredInspector = require("inspector");
const requiredInspectorPromises = require("node:inspector/promises");

strictEqual(requiredInspector.Session, inspector.Session, "require inspector Session mismatch");
strictEqual(requiredInspectorPromises.Session, inspectorPromises.Session, "require inspector/promises Session mismatch");

for (const name of ["close", "open", "url", "waitForDebugger"]) {
  strictEqual(typeof (inspector as Record<string, unknown>)[name], "function", `inspector.${name} should be exported`);
  strictEqual(typeof (inspectorPromises as Record<string, unknown>)[name], "function", `inspector/promises.${name} should be exported`);
}

strictEqual(typeof inspector.Session, "function", "inspector Session should be exported");
strictEqual(typeof inspector.Network.requestWillBeSent, "function", "inspector Network should be exported");
strictEqual(typeof inspector.NetworkResources.put, "function", "inspector NetworkResources should be exported");
strictEqual(typeof inspector.console.log, "function", "inspector console should be exported");
strictEqual(inspector.url(), undefined, "inspector url should be undefined without a server");

inspector.open(0, "127.0.0.1", false);
ok(/^ws:\/\/127\.0\.0\.1:\d+\//.test(inspector.url() ?? ""), "inspector.open should expose its bound URL");
try {
  inspector.open(0, "127.0.0.1", false);
  throw new Error("inspector.open should reject duplicate activation");
} catch (error) {
  strictEqual((error as Error & { code?: string }).code, "ERR_INSPECTOR_ALREADY_ACTIVATED", "duplicate inspector.open error code mismatch");
}
inspector.close();
strictEqual(inspector.url(), undefined, "inspector.close should clear the inspector URL");

try {
  inspector.waitForDebugger();
  throw new Error("waitForDebugger should throw when inspector is inactive");
} catch (error) {
  strictEqual((error as Error & { code?: string }).code, "ERR_INSPECTOR_NOT_ACTIVE", "waitForDebugger error code mismatch");
}

const session = new inspector.Session();
session.connect();
const evaluateResult = await new Promise<Record<string, any>>((resolve, reject) => {
  session.post("Runtime.evaluate", { expression: "20 + 22" }, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
});
strictEqual(evaluateResult.result.type, "number", "inspector Runtime.evaluate type mismatch");
strictEqual(evaluateResult.result.value, 42, "inspector Runtime.evaluate value mismatch");

const networkEvent = new Promise<Record<string, any>>((resolve) => {
  session.once("Network.requestWillBeSent", (event) => resolve(event));
});
inspector.Network.requestWillBeSent({ requestId: "1", request: { url: "https://example.test/" } });
const event = await networkEvent;
strictEqual(event.method, "Network.requestWillBeSent", "inspector Network event method mismatch");
strictEqual(event.params.requestId, "1", "inspector Network event params mismatch");

const resourceId = inspector.NetworkResources.put({ body: "payload" });
const resourceResult = await new Promise<Record<string, any>>((resolve, reject) => {
  session.post("Network.getResponseBody", { requestId: resourceId }, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
});
strictEqual(resourceResult.body, "payload", "inspector NetworkResources body mismatch");

const protocolError = await new Promise<Error & { code?: string }>((resolve, reject) => {
  session.post("Unknown.method", {}, (error) => {
    if (error) resolve(error as Error & { code?: string });
    else reject(new Error("Unknown inspector method should fail"));
  });
});
strictEqual(protocolError.code, "ERR_INSPECTOR_COMMAND", "inspector unknown method error code mismatch");
session.disconnect();

const promiseSession = new inspectorPromises.Session();
promiseSession.connect();
const promiseResult = await promiseSession.post("Runtime.evaluate", { expression: "6 * 7" });
strictEqual(promiseResult.result.value, 42, "inspector/promises Runtime.evaluate mismatch");
await promiseSession.post("Runtime.enable");
promiseSession.disconnect();

console.log("node inspector surface passed");
