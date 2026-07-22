import { expect, test } from "bun:test";
import {
  ReadableStream,
  ReadableStreamBYOBRequest,
} from "node:stream/web";
import { webcrypto } from "node:crypto";

function expectCode(callback: () => unknown, code: string) {
  expect(callback).toThrow(expect.objectContaining({ code }));
}

test("Web Crypto exposes a coherent global constructor", () => {
  expect(typeof globalThis.Crypto).toBe("function");
  expect(globalThis.crypto).toBe(webcrypto);
  expect(globalThis.crypto).toBeInstanceOf(globalThis.Crypto);
  expect(globalThis.crypto.constructor).toBe(globalThis.Crypto);
  expect(globalThis.crypto.subtle).toBeInstanceOf(globalThis.SubtleCrypto);
  expect(Object.prototype.toString.call(globalThis.crypto)).toBe("[object Crypto]");
  expect(() => new globalThis.Crypto()).toThrow(expect.objectContaining({ code: "ERR_ILLEGAL_CONSTRUCTOR" }));
});

test("ResponseInit uses Bun status coercion and field order", () => {
  expect(new Response(null, { status: 101 }).status).toBe(101);
  expect(new Response(null, { status: 101.9 }).status).toBe(101);
  expect(new Response(null, { status: 200.9 }).status).toBe(200);
  expect(new Response(null, { status: 599.9 }).status).toBe(599);
  expect(new Response(null, { status: "4294967496" as any }).status).toBe(200);
  expect(new Response(null, { status: 200n as any }).status).toBe(200);
  expect(() => new Response(null, { status: 199.9 })).toThrow(RangeError);
  expect(() => new Response(null, { status: Number.NaN })).toThrow(RangeError);
  expect(() => new Response(null, 1 as any)).toThrow(TypeError);

  const reads: string[] = [];
  const init = {
    get headers() { reads.push("headers"); return { "x-test": "yes" }; },
    get status() { reads.push("status"); return 204.8; },
    get statusText() { reads.push("statusText"); return false as any; },
    get method() { reads.push("method"); return "post"; },
    get url() { reads.push("url"); return "https://ignored.example/"; },
    get redirected() { reads.push("redirected"); return true; },
    get type() { reads.push("type"); return "error"; },
  };
  const response = new Response(null, init as any);
  expect(reads).toEqual(["headers", "status", "statusText", "method"]);
  expect(response.status).toBe(204);
  expect(response.statusText).toBe("false");
  expect(response.url).toBe("");
  expect(response.redirected).toBe(false);
  expect(response.type).toBe("default");
  expect(() => new Response(null, { statusText: Symbol("status") as any })).toThrow(TypeError);
  expect(() => new Response(null, { method: Symbol("method") as any } as any)).toThrow(TypeError);
});

test("RequestInit overlays use Bun coercion and inheritance", async () => {
  expect(new Request("https://example.com", 1 as any).method).toBe("GET");
  expect(new Request("https://example.com", { method: "post", status: 200.9 } as any).method).toBe("POST");
  expect(() => new Request("https://example.com", { status: 199.9 } as any)).toThrow(RangeError);

  const source = new Request("https://example.com/source", {
    method: "POST",
    headers: { inherited: "yes" },
  });
  expect(new Request(source, { method: undefined }).method).toBe("POST");
  expect(new Request(source, { method: null as any }).method).toBe("GET");
  expect(new Request(source, { headers: {} }).headers.get("inherited")).toBe("yes");
  expect(new Request(source, { headers: new Headers() }).headers.get("inherited")).toBe("yes");
  expect(new Request(source, { headers: { replacement: "yes" } }).headers.get("inherited")).toBeNull();

  expect(() => new Request("https://example.com", { signal: false as any })).toThrow(Error);
  const inheritedSignal = new Request(source, { signal: null as any });
  expect(inheritedSignal.signal).toBe(source.signal);

  let initHeadersRead = false;
  const input = { toString() { throw new Error("input conversion"); } };
  const init = { get headers() { initHeadersRead = true; return {}; } };
  expect(() => new Request(input as any, init)).toThrow("input conversion");
  expect(initHeadersRead).toBe(true);

  initHeadersRead = false;
  expect(async () => await fetch(input as any, init)).toThrow("input conversion");
  expect(initHeadersRead).toBe(false);

  expect(new Request(source, { url: "https://example.com/override" } as any).url)
    .toBe("https://example.com/override");
  expect(new Request({ url: "https://example.com/object" } as any, {
    url: "https://example.com/object-override",
  } as any).url).toBe("https://example.com/object-override");
  expect(new Request("https://example.com/string", {
    url: "https://example.com/string-override",
  } as any).url).toBe("https://example.com/string");

  let headersReads = 0;
  let methodReads = 0;
  new Request(source, {
    get headers() { headersReads += 1; return undefined; },
    get method() { methodReads += 1; return undefined; },
  });
  expect(headersReads).toBe(2);
  expect(methodReads).toBe(2);
  expect(() => new Request("invalid", {
    get headers() { throw new Error("headers before URL validation"); },
  })).toThrow("headers before URL validation");
});

test("byte streams expose Bun and Node validation codes", async () => {
  const unlocked = new ReadableStream({ type: "bytes" });
  for (const mode of ["", null, "asdf"]) {
    expectCode(() => unlocked.getReader({ mode } as any), "ERR_INVALID_ARG_VALUE");
  }
  for (const options of [1, "asdf"]) {
    expectCode(() => unlocked.getReader(options as any), "ERR_INVALID_ARG_TYPE");
  }

  expectCode(
    () => Reflect.get(ReadableStreamBYOBRequest.prototype, "view", {}),
    "ERR_INVALID_THIS",
  );
  expectCode(
    () => ReadableStreamBYOBRequest.prototype.respond.call({} as any, 0),
    "ERR_INVALID_THIS",
  );

  let checkedRequestErrors = false;
  const stream = new ReadableStream({
    type: "bytes",
    pull(controller) {
      const request = controller.byobRequest!;
      expectCode(() => request.respondWithNewView({} as any), "ERR_INVALID_ARG_TYPE");
      request.view![0] = 42;
      request.respond(1);
      expectCode(() => request.respond(1), "ERR_INVALID_STATE");
      expectCode(() => request.respondWithNewView(new Uint8Array(1)), "ERR_INVALID_STATE");
      checkedRequestErrors = true;
      controller.close();
    },
  });
  const reader = stream.getReader({ mode: "byob" });
  expect((await reader.read(new Uint8Array(1))).value?.[0]).toBe(42);
  expect(checkedRequestErrors).toBe(true);

  const released = new ReadableStream({ type: "bytes" }).getReader({ mode: "byob" });
  released.releaseLock();
  released.releaseLock();
  await expect(released.read(new Uint8Array(1))).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });
  await expect(released.cancel()).rejects.toMatchObject({ code: "ERR_INVALID_STATE" });

  let controller: ReadableByteStreamController;
  new ReadableStream({ type: "bytes", start(value) { controller = value; } });
  expectCode(() => controller!.enqueue(1 as any), "ERR_INVALID_ARG_TYPE");
  controller!.close();
  expectCode(() => controller!.enqueue(new Uint8Array(1)), "ERR_INVALID_STATE");
  expectCode(() => controller!.close(), "ERR_INVALID_STATE");
});

test("AbortSignal timeout conversion and default reasons match Bun", async () => {
  expect(AbortSignal.timeout(-0.1).aborted).toBe(false);
  expect(AbortSignal.timeout(Number.MAX_SAFE_INTEGER).aborted).toBe(false);
  for (const delay of [-1, Number.NaN, Infinity, Number.MAX_VALUE]) {
    expect(() => AbortSignal.timeout(delay)).toThrow(TypeError);
  }
  expect(() => AbortSignal.timeout(1n as any)).toThrow(TypeError);

  const aborted = AbortSignal.abort();
  expect(aborted.reason).toBeInstanceOf(DOMException);
  expect(aborted.reason.name).toBe("AbortError");
  expect(aborted.reason.message).toBe("The operation was aborted.");

  const timedOut = AbortSignal.timeout(0);
  await Bun.sleep(5);
  expect(timedOut.reason).toBeInstanceOf(DOMException);
  expect(timedOut.reason.name).toBe("TimeoutError");
  expect(timedOut.reason.message).toBe("The operation timed out.");
});

test("multipart parser handles extended filenames and strict errors", async () => {
  const boundary = "edge-boundary";
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="emoji"; filename*UTF-8''%F0%9F%9A%80.js`,
    "Content-Type: application/javascript;charset=utf-8",
    "",
    "payload",
    `--${boundary}`,
    `Content-Disposition: form-data; name="latin"; filename*=ISO-8859-1''caf%E9.txt`,
    "",
    "latin payload",
    `--${boundary}`,
    `Content-Disposition: form-data; name="fallback;field"; filename="fallback.txt"; filename*=UTF-8''bad%ZZ`,
    "",
    "fallback payload",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  const form = await new Response(body, {
    headers: { "content-type": `multipart/form-data; boundary="${boundary}"` },
  }).formData();

  const emoji = form.get("emoji") as File;
  expect(emoji).toBeInstanceOf(File);
  expect(emoji.name).toBe("🚀.js");
  expect(await emoji.text()).toBe("payload");
  expect((form.get("latin") as File).name).toBe("café.txt");
  expect((form.get("fallback;field") as File).name).toBe("fallback.txt");

  let missingFinal: unknown;
  try {
    await new Response(`--${boundary}\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue`, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    }).formData();
  } catch (error) {
    missingFinal = error;
  }
  expect(missingFinal).toBeInstanceOf(TypeError);
  expect((missingFinal as Error).message).toBe("FormData parse error missing final boundary");

  await expect(new Response("value", {
    headers: { "content-type": "multipart/form-data" },
  }).formData()).rejects.toBeInstanceOf(TypeError);
});
