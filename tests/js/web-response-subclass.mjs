import assert from "node:assert/strict";

const statusDescriptor = Object.getOwnPropertyDescriptor(Response.prototype, "status");
assert.equal(typeof statusDescriptor.get, "function");
assert.equal(statusDescriptor.set, undefined);
assert.equal(statusDescriptor.enumerable, true);

for (const receiver of [undefined, null, 1, "response", {}, Response.prototype, Object.create(Response.prototype)]) {
  assert.throws(() => statusDescriptor.get.call(receiver), TypeError);
}

const plain = new Response("plain", { status: 201 });
assert.equal(Object.hasOwn(plain, "status"), false);
assert.equal(plain.status, 201);
assert.equal(Reflect.set(plain, "status", 202), false);
assert.equal(plain.status, 201);
const enumerableProperties = [];
for (const property in plain) enumerableProperties.push(property);
assert.equal(enumerableProperties.includes("status"), true);

// Miniflare overrides status this way to expose a WebSocket upgrade while
// keeping its underlying native Response initialized with a valid status.
const webSocket = Symbol("webSocket");
class WorkerResponse extends Response {
  constructor(body, init, upgrade = false) {
    super(body, init);
    this[webSocket] = upgrade;
  }
  get status() {
    return this[webSocket] ? 101 : super.status;
  }
}

const response = new WorkerResponse("worker", {
  status: 202,
  statusText: "Accepted",
  headers: { "x-response": "subclass" },
});
assert.equal(response.status, 202);
assert.equal(response.ok, true);
assert.equal(response.headers.get("x-response"), "subclass");
const responseClone = response.clone();
assert.equal(responseClone.constructor, Response);
assert.equal(responseClone.status, 202);
assert.equal(responseClone.statusText, "Accepted");
assert.equal(responseClone.headers.get("x-response"), "subclass");
assert.equal(await responseClone.text(), "worker");
assert.equal(await response.text(), "worker");

const upgrade = new WorkerResponse(null, { status: 201 }, true);
assert.equal(upgrade.status, 101);
assert.equal(statusDescriptor.get.call(upgrade), 201);
assert.equal(upgrade.ok, true);
assert.equal(upgrade.clone().status, 201);

const failedUpgrade = new WorkerResponse(null, { status: 503 }, true);
assert.equal(failedUpgrade.status, 101);
assert.equal(failedUpgrade.ok, false);
assert.equal(failedUpgrade.clone().status, 503);

const error = Response.error();
assert.equal(error.status, 0);
assert.equal(error.ok, false);
assert.equal(error.type, "error");
assert.equal(error.clone().status, 0);
assert.equal(error.clone().type, "error");

const json = Response.json({ ok: true }, { status: 201 });
assert.equal(json.status, 201);
assert.deepEqual(await json.json(), { ok: true });
const redirected = Response.redirect("https://example.com/", 307);
assert.equal(redirected.status, 307);
assert.equal(redirected.clone().status, 307);
assert.equal(redirected.headers.get("location"), "https://example.com/");

console.log("web response subclass passed");
