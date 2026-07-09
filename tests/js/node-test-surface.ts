import testDefault, {
  after,
  afterEach,
  assert as testAssert,
  before,
  beforeEach,
  describe,
  it,
  mock,
  only,
  run,
  skip,
  snapshot,
  suite,
  test,
  todo,
} from "node:test";
import { createRequire } from "node:module";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const require = createRequire(import.meta.url);
assert(require("node:test") === testDefault, "require node:test default mismatch");
assert(testDefault.test === test, "node:test default properties mismatch");
assert(testDefault.it === it, "node:test it property mismatch");

const order: string[] = [];
before(() => { order.push("before"); });
beforeEach(() => { order.push("beforeEach"); });
afterEach(() => { order.push("afterEach"); });
after(() => { order.push("after"); });

await test("basic pass", (t) => {
  t.diagnostic("hello");
  testAssert.strictEqual(1 + 1, 2);
  order.push("test");
});

await it("it pass", () => {
  order.push("it");
});

await only("only pass", () => {
  order.push("only");
});

await skip("skip pass");
await todo("todo pass");

let suiteRan = false;
await describe("suite pass", () => {
  suiteRan = true;
});
await suite("suite alias pass", () => {});
assert(suiteRan, "describe should execute callback");

const calls: number[] = [];
const fn = mock.fn((value: number) => {
  calls.push(value);
  return value + 1;
});
assert(fn(1) === 2, "mock.fn result mismatch");
assert(fn.mock.callCount() === 1 && calls[0] === 1, "mock.fn calls mismatch");

const object = {
  value: 1,
  add(value: number) {
    return this.value + value;
  },
};
const method = mock.method(object, "add", function add(value: number) {
  return value * 2;
});
assert(object.add(3) === 6 && method.mock.callCount() === 1, "mock.method mismatch");
mock.property(object, "value", 10);
assert(object.value === 10, "mock.property mismatch");
mock.restoreAll();
assert(object.value === 1 && object.add(3) === 4, "mock.restoreAll mismatch");

snapshot.setDefaultSnapshotSerializers([(value) => String(value)]);
snapshot.setResolveSnapshotPath((path) => `${path}.snap`);

const events: any[] = [];
for await (const event of run()) events.push(event);

assert(order.includes("before") && order.includes("after"), "test hooks mismatch");
assert(events.some((event) => event.type === "test:pass" && event.data.name === "basic pass"), "run pass event mismatch");
assert(events.some((event) => event.type === "test:diagnostic"), "diagnostic event mismatch");
assert(events.some((event) => event.data?.skip), "skip event mismatch");
assert(events.some((event) => event.data?.todo), "todo event mismatch");
assert(typeof testDefault.run === "function", "default run export mismatch");

console.log("node test surface passed");
