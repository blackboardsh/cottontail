import { expect, test } from "bun:test";
const captureFailure = require(`${import.meta.dir}/node-assert-ok-source-fixture.cjs`);

test("assert.ok reports the failing source expression", () => {
  const failure = captureFailure();

  expect(failure.generatedMessage).toBe(true);
  expect(failure.message).toBe(
    "The expression evaluated to a falsy value:\n\n  assert.ok(false)\n",
  );
});
