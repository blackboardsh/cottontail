import { expect, test } from "bun:test";

test("FormData.from reads an in-memory Blob synchronously", () => {
  const boundary = "cottontail-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="field"',
    "",
    "value",
    `--${boundary}--`,
    "",
  ].join("\r\n");

  const form = FormData.from(new Blob([body]), boundary);
  expect(form.get("field")).toBe("value");
});

test("releasing a reader rejects pending work with Bun's AbortError", async () => {
  const { promise, resolve } = Promise.withResolvers<void>();
  const stream = new ReadableStream({
    async pull(controller) {
      controller.enqueue("first");
      await promise;
      controller.enqueue("second");
      controller.close();
    },
  });
  let reader = stream.getReader();

  expect((await reader.read()).value).toBe("first");
  const pendingRead = reader.read();
  reader.releaseLock();

  for (const pending of [pendingRead, reader.closed]) {
    expect(pending).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_STREAM_RELEASE_LOCK",
    });
  }

  resolve();
  reader = stream.getReader();
  expect((await reader.read()).value).toBe("second");
});
