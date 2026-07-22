import { afterAll, expect, test } from "bun:test";

const root = `${cottontail.cwd()}/.cottontail-tmp/bun-file-io-${process.pid}-${Date.now()}`;
const encoder = new TextEncoder();

cottontail.mkdirSync(root, true);
afterAll(() => cottontail.rmSync(root, true, true));

function fixture(name: string) {
  return `${root}/${name}`;
}

test("Bun.file accepts URL and BufferSource paths and normalizes MIME types", async () => {
  const path = fixture("style.css");
  cottontail.writeFile(path, "body {}");

  expect(Bun.file(Bun.pathToFileURL(path)).name).toBe(path);
  expect(Bun.file(encoder.encode(path)).name).toBe(path);
  expect(Bun.file(Bun.pathToFileURL(path).href).name).toBe(Bun.pathToFileURL(path).href);
  expect(Bun.file(path).type).toBe("text/css;charset=utf-8");
  expect(Bun.file(fixture("image.bmp")).type).toBe("image/x-ms-bmp");
  expect(Bun.file(fixture("config.yaml")).type).toBe("text/yaml");
  expect(Bun.file(fixture("document.docx")).type).toBe(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(Bun.file(fixture("UPPER.CSS")).type).toBe("application/octet-stream");
  expect(Bun.file(fixture("literal.css?query")).type).toBe("application/octet-stream");
  expect(Bun.file(fixture(".json")).type).toBe("application/octet-stream");
  expect(Bun.file(path, { type: "CUSTOM/MimeType" }).type).toBe("custom/mimetype");
  expect(Bun.file(path, { type: "text/\u{1f4a5}" }).type).toBe("text/css;charset=utf-8");
  expect(await Bun.file(encoder.encode(path)).text()).toBe("body {}");
});

test("file slices stay lazy, compose offsets, and stream in bounded chunks", async () => {
  const path = fixture("lazy-slice.txt");
  cottontail.writeFile(path, "abcdefghij");
  const slice = Bun.file(path).slice(2, 8);
  const nested = slice.slice(1, 4);

  cottontail.writeFile(path, "0123456789");
  expect(await slice.text()).toBe("234567");
  expect(await nested.text()).toBe("345");

  const chunks: Uint8Array[] = [];
  for await (const chunk of slice.stream(2)) chunks.push(chunk);
  expect(chunks.every(chunk => chunk.byteLength <= 2)).toBe(true);
  expect(new TextDecoder().decode(Bun.concatArrayBuffers(chunks))).toBe("234567");
});

test("descriptor-backed files consume the fd cursor without taking ownership", async () => {
  const path = fixture("descriptor.txt");
  cottontail.writeFile(path, "descriptor-data");
  const fd = cottontail.openFd(path, "r");

  try {
    const file = Bun.file(fd);
    expect(await file.text()).toBe("descriptor-data");
    expect((await file.bytes()).byteLength).toBe(0);
    expect(cottontail.fstatSync(fd).isFile).toBe(true);
  } finally {
    cottontail.closeFd(fd);
  }
});

test("FileSink opens eagerly, does not truncate, and only reports each flush", async () => {
  const path = fixture("writer.txt");
  cottontail.writeFile(path, "original");
  const sink = Bun.file(path).writer();

  expect(cottontail.readFile(path)).toBe("original");
  expect(sink.write("xy")).toBe(2);
  expect(cottontail.readFile(path)).toBe("original");
  expect(await sink.flush()).toBe(2);
  expect(cottontail.readFile(path)).toBe("xyiginal");
  expect(await sink.end()).toBe(0);
  expect(sink.write("ignored")).toBe(true);

  const fd = cottontail.openFd(path, "r+");
  try {
    const fdSink = Bun.file(fd).writer();
    expect(fdSink.write("FD")).toBe(2);
    expect(await fdSink.end()).toBe(2);
    expect(cottontail.fstatSync(fd).isFile).toBe(true);
  } finally {
    cottontail.closeFd(fd);
  }
});

test("Bun.write pulls Response bodies incrementally and preserves partial output on error", async () => {
  const path = fixture("response-stream.txt");
  const parts = [encoder.encode("first-"), encoder.encode("second-"), encoder.encode("third")];
  let pulls = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      const part = parts[pulls++];
      if (part) controller.enqueue(part);
      else controller.close();
    },
  }));

  expect(await Bun.write(path, response)).toBe(18);
  expect(cottontail.readFile(path)).toBe("first-second-third");
  expect(pulls).toBe(4);
  expect(response.bodyUsed).toBe(true);

  const partialPath = fixture("partial-error.txt");
  let read = 0;
  const failing = new Response(new ReadableStream({
    async pull(controller) {
      if (read++ === 0) {
        controller.enqueue(encoder.encode("written-before-error"));
        return;
      }
      while (cottontail.readFile(partialPath) !== "written-before-error") {
        await Bun.sleep(1);
      }
      controller.error(new Error("source failed"));
    },
  }));
  let sourceError: Error | undefined;
  try {
    await Bun.write(partialPath, failing);
  } catch (error) {
    sourceError = error as Error;
  }
  expect(sourceError?.message).toBe("source failed");
  expect(cottontail.readFile(partialPath)).toBe("written-before-error");
});

test("Bun.write validates ownership, ignores AbortSignal, and opens file sources first", async () => {
  const destination = fixture("atomic-destination.txt");
  cottontail.writeFile(destination, "keep-me");
  await expect(Bun.write(destination, Bun.file(fixture("missing-source.txt")))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(cottontail.readFile(destination)).toBe("keep-me");

  const controller = new AbortController();
  controller.abort();
  expect(await Bun.write(destination, "signal-is-ignored", { signal: controller.signal })).toBe(17);
  expect(cottontail.readFile(destination)).toBe("signal-is-ignored");

  const fd = cottontail.openFd(destination, "r+");
  try {
    expect(() => Bun.write(Bun.file(fd), "nope", { createPath: true })).toThrow(
      "Cannot create a directory for a file descriptor",
    );
    expect(await Bun.write(fd, "")).toBe(0);
    expect(cottontail.fstatSync(fd).size).toBe(0);
  } finally {
    cottontail.closeFd(fd);
  }
});

test("Bun 1.3.10 destination slices and direct ReadableStreams retain their route semantics", async () => {
  const slicePath = fixture("destination-slice.txt");
  cottontail.writeFile(slicePath, "abcdefgh");
  expect(await Bun.write(Bun.file(slicePath).slice(3, 6), "xy")).toBe(2);
  expect(cottontail.readFile(slicePath)).toBe("xy");

  const streamPath = fixture("direct-stream.txt");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("not-consumed"));
      controller.close();
    },
  });
  expect(await Bun.write(streamPath, stream)).toBe("[object ReadableStream]".length);
  expect(cottontail.readFile(streamPath)).toBe("[object ReadableStream]");
});
