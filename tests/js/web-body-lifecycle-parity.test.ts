import { expect, test } from "bun:test";

function postRequest(body: unknown) {
  return new Request("http://example.com/", { method: "POST", body: body as any });
}

test("BodyInit snapshots mutable buffer sources and Blob-part arrays", async () => {
  for (const make of [
    (body: unknown) => new Response(body as any),
    (body: unknown) => postRequest(body),
  ]) {
    const bytes = new TextEncoder().encode("alpha");
    const body = make(bytes.subarray(1, 4));
    bytes.fill("x".charCodeAt(0));
    expect(await body.text()).toBe("lph");

    const backing = new TextEncoder().encode("xalpha-y");
    const parts = [backing.subarray(1, 6), new TextEncoder().encode(" beta")];
    const multipart = make(parts);
    backing.fill(0);
    parts.push(new TextEncoder().encode(" ignored"));
    expect(await multipart.text()).toBe("alpha beta");

    const params = new URLSearchParams({ field: "initial value" });
    const encoded = make(params);
    params.set("field", "mutated");
    expect(encoded.headers.get("content-type")).toBe("application/x-www-form-urlencoded;charset=UTF-8");
    expect(await encoded.text()).toBe("field=initial+value");
    expect(make("plain text").headers.get("content-type")).toBeNull();
  }

  expect(() => new Response(Symbol("body") as any)).toThrow(TypeError);
  expect(() => new Blob([Symbol("part") as any])).toThrow(TypeError);
});

test("Blob and File bodies retain metadata without retaining wrapper identity", async () => {
  const source = new Blob(["contents"], { type: "text/example" });
  const response = new Response(source);
  const clone = response.clone();
  const first = await response.blob();
  const second = await clone.blob();

  expect(first).not.toBe(source);
  expect(second).not.toBe(source);
  expect(second).not.toBe(first);
  expect(first.type).toBe("text/example");
  expect(await first.text()).toBe("contents");
  expect(await second.text()).toBe("contents");

  const file = new File(["file contents"], "input.txt", {
    type: "text/plain",
    lastModified: 123,
  });
  const output = await new Response(file).blob();
  expect(output).not.toBe(file);
  expect(output).toBeInstanceOf(File);
  expect((output as File).name).toBe("input.txt");
  expect((output as File).lastModified).toBe(123);

  const form = new FormData();
  form.append("file", new Blob(["wrapped contents"]), "wrapped.txt");
  const wrapped = form.get("file") as File;
  const wrappedOutput = await new Response(wrapped).blob();
  expect(wrappedOutput).not.toBe(wrapped);
  expect(wrappedOutput).toBeInstanceOf(File);
  expect((wrappedOutput as File).name).toBe("wrapped.txt");
  expect(await wrappedOutput.text()).toBe("wrapped contents");

  const bunFile = Bun.file("package.json");
  const bunFileOutput = await new Response(bunFile).blob();
  expect(bunFileOutput).not.toBe(bunFile);
  expect((bunFileOutput as any).name).toBe("package.json");
  expect(typeof (bunFileOutput as any).exists).toBe("function");
  expect(await bunFileOutput.text()).toContain('"name": "cottontail"');
});

test("FormData is captured when attached and reparsed per body consumer", async () => {
  const source = new FormData();
  source.append("field", "original");
  source.append("upload", new Blob(["payload"], { type: "text/plain" }), "data.txt");

  const response = new Response(source);
  const clone = response.clone();
  source.set("field", "mutated");
  source.append("late", "ignored");

  expect(clone.headers.get("content-type")).toBe(response.headers.get("content-type"));
  const first = await response.formData();
  const second = await clone.formData();
  expect(first).not.toBe(source);
  expect(second).not.toBe(source);
  expect(second).not.toBe(first);
  expect(first.get("field")).toBe("original");
  expect(second.get("field")).toBe("original");
  expect(first.has("late")).toBe(false);
  expect(await (first.get("upload") as File).text()).toBe("payload");
});

test("bodyUsed follows lock and disturbance rules for buffered and custom streams", async () => {
  const buffered = new Response("buffered");
  const bufferedReader = buffered.body!.getReader();
  expect(buffered.bodyUsed).toBe(true);
  bufferedReader.releaseLock();
  expect(buffered.bodyUsed).toBe(true);

  const customStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("streamed"));
      controller.close();
    },
  });
  const streamed = new Response(customStream);
  const customReader = streamed.body!.getReader();
  expect(streamed.bodyUsed).toBe(false);
  customReader.releaseLock();
  expect(streamed.bodyUsed).toBe(false);

  const reading = streamed.body!.getReader();
  expect((await reading.read()).done).toBe(false);
  expect(streamed.bodyUsed).toBe(true);
  reading.releaseLock();
});

test("body async iterators become used on first iteration, not creation", async () => {
  const unused = new Response("value");
  const unusedIterator = unused.body![Symbol.asyncIterator]();
  expect(unused.bodyUsed).toBe(false);
  await unusedIterator.return?.();
  expect(unused.bodyUsed).toBe(false);

  const response = new Response("value");
  const iterator = response.body![Symbol.asyncIterator]();
  expect(response.bodyUsed).toBe(false);
  expect((await iterator.next()).done).toBe(false);
  expect(response.bodyUsed).toBe(true);
});

test("body convenience methods detach an exposed buffered stream", async () => {
  for (const body of [new Response("value"), postRequest("value")]) {
    const stream = body.body!;
    expect(await body.text()).toBe("value");
    expect(body.body).toBe(stream);
    expect(stream.locked).toBe(false);
    expect((await stream.getReader().read()).done).toBe(true);
  }
});

test("clone copies buffered bodies and tees streaming bodies", async () => {
  const buffered = new Response("buffered");
  const originalBody = buffered.body;
  const bufferedClone = buffered.clone();
  expect(buffered.body).toBe(originalBody);

  const originalReader = buffered.body!.getReader();
  const cloneReader = bufferedClone.body!.getReader();
  expect(buffered.bodyUsed).toBe(false);
  expect(bufferedClone.bodyUsed).toBe(true);
  originalReader.releaseLock();
  cloneReader.releaseLock();

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("teed"));
      controller.close();
    },
  });
  const streamed = new Response(stream);
  const oldBody = streamed.body!;
  const streamedClone = streamed.clone();
  expect(oldBody.locked).toBe(true);
  expect(streamed.body).not.toBe(oldBody);
  expect(await streamed.text()).toBe("teed");
  expect(await streamedClone.text()).toBe("teed");
});

test("Request construction distinguishes consumed values from disturbed streams", async () => {
  const consumed = postRequest("value");
  await consumed.text();
  const emptyCopy = new Request(consumed);
  expect(emptyCopy.body).not.toBeNull();
  expect(await emptyCopy.text()).toBe("");

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("value"));
      controller.close();
    },
  });
  const disturbed = postRequest(stream);
  await disturbed.text();
  let copyError: unknown;
  try {
    const copy = new Request(disturbed);
    await copy.text();
  } catch (error) {
    copyError = error;
  }
  expect(copyError).toBeInstanceOf(TypeError);
});

test("HTMLRewriter keeps non-string Response bodies consumable", async () => {
  const source = new Response(new TextEncoder().encode("<p>before</p>"));
  const output = new HTMLRewriter()
    .on("p", { element(element) { element.setInnerContent("after"); } })
    .transform(source);

  expect(output).toBeInstanceOf(Response);
  expect(await output.text()).toBe("<p>after</p>");
  expect(source.bodyUsed).toBe(true);
});

test("fetch and Bun.serve detach exposed buffered bodies", async () => {
  const outgoing = new Response("server payload");
  const outgoingStream = outgoing.body!;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/outgoing") return outgoing;
      return new Response(await request.text());
    },
  });
  try {
    const request = new Request(server.url, { method: "POST", body: "payload" });
    const stream = request.body!;
    const response = await fetch(request);
    expect(await response.text()).toBe("payload");
    expect(request.bodyUsed).toBe(true);
    expect(request.body).toBe(stream);
    expect((await stream.getReader().read()).done).toBe(true);

    const served = await fetch(new URL("/outgoing", server.url));
    expect(await served.text()).toBe("server payload");
    expect(outgoing.bodyUsed).toBe(true);
    expect(outgoing.body).toBe(outgoingStream);
    expect((await outgoingStream.getReader().read()).done).toBe(true);
  } finally {
    await server.stop(true);
  }
});
