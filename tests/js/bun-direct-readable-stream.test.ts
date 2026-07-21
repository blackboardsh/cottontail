import { describe, expect, test } from "bun:test";
import { ReadableStream } from "node:stream/web";

const decoder = new TextDecoder();

function text(value: unknown) {
  return decoder.decode(value as ArrayBufferView);
}

describe("Bun direct ReadableStream", () => {
  test("is lazy and defers synchronous flush and close until pull returns", async () => {
    const events: unknown[] = [];
    const source = {
      type: "direct",
      start() {
        events.push("start");
      },
      pull(sink: any) {
        events.push(["pull", this === source]);
        expect(sink.write("a")).toBe(1);
        expect(sink.flush()).toBe(1);
        expect(sink.write("b")).toBe(1);
        expect(sink.end("complete")).toBeUndefined();
      },
      close(reason: unknown) {
        events.push(["close", reason]);
      },
      cancel(reason: unknown) {
        events.push(["cancel", reason]);
      },
    };

    const stream = new globalThis.ReadableStream(source as any);
    expect(events).toEqual([]);

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(text(first.value)).toBe("ab");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(events).toEqual([
      ["pull", true],
      ["close", "complete"],
    ]);
  });

  test("accepts Bun sink chunk types and reports encoded byte lengths", async () => {
    const writes: number[] = [];
    const errors: string[] = [];
    const shared = typeof SharedArrayBuffer === "function" ? new SharedArrayBuffer(3) : new ArrayBuffer(3);
    const stream = new ReadableStream({
      type: "direct",
      pull(sink: any) {
        writes.push(sink.write(new String("x")));
        writes.push(sink.write("😋"));
        writes.push(sink.write(new Uint16Array([1, 2])));
        writes.push(sink.write(new DataView(new ArrayBuffer(3))));
        writes.push(sink.write(shared));
        for (const value of [null, 1, {}]) {
          try {
            sink.write(value);
          } catch (error: any) {
            errors.push(error.message);
          }
        }
        sink.close();
      },
    } as any);

    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.value.byteLength).toBe(15);
    expect(writes).toEqual([1, 4, 4, 3, 3]);
    expect(errors).toEqual(Array(3).fill("write() expects a string, ArrayBufferView, or ArrayBuffer"));
    expect((await reader.read()).done).toBe(true);
  });

  test("flushes asynchronous writes at explicit boundaries", async () => {
    const closeReasons: unknown[] = [];
    const stream = new ReadableStream({
      type: "direct",
      async pull(sink: any) {
        sink.write("first");
        await Promise.resolve();
        expect(sink.flush()).toBe(5);
        sink.write("second");
        await Promise.resolve();
        sink.close("finished");
      },
      close(reason: unknown) {
        closeReasons.push(reason);
      },
    } as any);

    const reader = stream.getReader();
    expect(text((await reader.read()).value)).toBe("first");
    expect(text((await reader.read()).value)).toBe("second");
    expect((await reader.read()).done).toBe(true);
    expect(closeReasons).toEqual(["finished"]);
  });

  test("finishes an HTTP-style direct sink when async pull settles", async () => {
    let leakedSink: any;
    const cancellations: unknown[] = [];
    const stream = new ReadableStream({
      type: "direct",
      async pull(sink: any) {
        leakedSink = sink;
        sink.write("a");
        await Promise.resolve();
        sink.write("b");
      },
      cancel(reason: unknown) {
        cancellations.push(reason);
      },
    } as any);

    const reader = stream.getReader();
    expect(text((await reader.read()).value)).toBe("ab");
    expect((await reader.read()).done).toBe(true);
    expect(cancellations).toEqual([undefined]);
    expect(() => leakedSink.write("c")).toThrow(
      'This HTTPResponseSink has already been closed. A "direct" ReadableStream terminates its underlying socket once `async pull()` returns.',
    );
    expect(() => leakedSink.write.call({}, "c")).toThrow("Expected HTTPResponseSink");
  });

  test("propagates reader cancellation once and invalidates the sink", async () => {
    let leakedSink: any;
    let releasePull!: () => void;
    const reason = new Error("stop");
    const cancellations: unknown[] = [];
    const source = {
      type: "direct",
      pull(sink: any) {
        leakedSink = sink;
        return new Promise<void>((resolve) => {
          releasePull = resolve;
        });
      },
      cancel(value: unknown) {
        cancellations.push([this === source, value]);
      },
    };

    const reader = new ReadableStream(source as any).getReader();
    const pendingRead = reader.read();
    await Promise.resolve();
    await reader.cancel(reason);
    expect(await pendingRead).toEqual({ done: true, value: undefined });
    expect(cancellations).toEqual([[true, reason]]);
    expect(() => leakedSink.flush()).toThrow("This HTTPResponseSink has already been closed");
    releasePull();
  });

  test("discards buffered bytes and propagates pull and sink errors", async () => {
    for (const mode of ["throw", "reject", "sink"] as const) {
      const expected = new Error(mode);
      const closedWith: unknown[] = [];
      const stream = new ReadableStream({
        type: "direct",
        pull(sink: any) {
          sink.write("discard me");
          if (mode === "throw") throw expected;
          if (mode === "reject") return Promise.reject(expected);
          sink.error(expected);
        },
        close(reason: unknown) {
          closedWith.push(reason);
        },
      } as any);

      let received: unknown;
      try {
        await stream.getReader().read();
      } catch (error) {
        received = error;
      }
      expect(received).toBe(expected);
      expect(closedWith).toEqual([expected]);
    }
  });
});
