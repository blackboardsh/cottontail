import { EventEmitter } from "node:events";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  assertBunAbortSignal,
  bunSignalNumber,
  normalizeBunSpawnCommand,
  normalizeBunSpawnTimeout,
  validateBunSpawnCallbacks,
} from "../../src/runtime_modules/internal/bun-spawn-contract.js";
import {
  decodeBunSpawnIpc,
  encodeBunSpawnIpc,
  installInheritedNodeIpc,
} from "../../src/runtime_modules/internal/bun-spawn-ipc.js";

test("Bun.spawn command and option contracts reject non-Bun extensions", () => {
  expect(() => normalizeBunSpawnCommand("true" as any)).toThrow("cmd must be an array");
  expect(() => normalizeBunSpawnCommand(["true", Symbol("argument")])).toThrow(
    "Cannot convert a symbol to a string",
  );
  expect(() => bunSignalNumber("sigterm")).toThrow("signal must be one of");
  expect(() => normalizeBunSpawnTimeout(-Infinity)).toThrow(RangeError);
  expect(() => assertBunAbortSignal({ aborted: false, addEventListener() {} } as any)).toThrow(
    'The "signal" argument must be of type AbortSignal',
  );
  expect(() => validateBunSpawnCallbacks({ ipc() {}, serialization: 1 })).toThrow(
    "Expected serialization to be a string for 'spawn'.",
  );
  expect(() => validateBunSpawnCallbacks({ ipc() {}, serialization: "invalid" }, true)).not.toThrow();
});

test("advanced Bun.spawn IPC preserves structured values", () => {
  const input: any = {
    bigint: 9007199254740993n,
    map: new Map([["answer", 42]]),
    typed: new Uint16Array([7, 11]),
  };
  input.self = input;

  const frame = encodeBunSpawnIpc(input);
  expect(frame.startsWith("__COTTONTAIL_IPC__{")).toBe(true);

  const output: any = decodeBunSpawnIpc(frame.trim());
  expect(output.bigint).toBe(input.bigint);
  expect(output.map).toBeInstanceOf(Map);
  expect(output.map.get("answer")).toBe(42);
  expect(output.typed).toBeInstanceOf(Uint16Array);
  expect([...output.typed]).toEqual([7, 11]);
  expect(output.self).toBe(output);
});

test("Bun.spawn IPC validates top-level messages", () => {
  try {
    encodeBunSpawnIpc(undefined);
    expect.unreachable();
  } catch (error: any) {
    expect(error.message).toContain('The "message" argument must be specified');
    expect(error.code).toBe("ERR_MISSING_ARGS");
  }
  try {
    encodeBunSpawnIpc(1n);
    expect.unreachable();
  } catch (error: any) {
    expect(error.message).toContain("Received type bigint (1n)");
    expect(error.code).toBe("ERR_INVALID_ARG_TYPE");
  }
  try {
    encodeBunSpawnIpc(Symbol("ipc"));
    expect.unreachable();
  } catch (error: any) {
    expect(error.message).toContain("Received type symbol (Symbol(ipc))");
    expect(error.code).toBe("ERR_INVALID_ARG_TYPE");
  }
  expect(() => encodeBunSpawnIpc(() => {})).toThrow("The object can not be cloned.");
});

test("inherited Node JSON IPC preserves UTF-8 split across reads", async () => {
  class MockProcess extends EventEmitter {
    env: Record<string, string> = {
      NODE_CHANNEL_FD: "3",
      NODE_CHANNEL_SERIALIZATION_MODE: "json",
    };
    connected = false;
    channel: any = null;
    _channel: any = null;
    send?: (...args: any[]) => boolean;
    disconnect?: () => void;
  }

  const processObject = new MockProcess();
  const bytes = new TextEncoder().encode(`${JSON.stringify({ text: "split-€-frame" })}\n`);
  const splitAt = bytes.indexOf(0xe2) + 1;
  const reads: any[] = [
    { data: bytes.slice(0, splitAt) },
    { data: bytes.slice(splitAt) },
    null,
  ];
  let sent = "";
  const host = {
    ipcRecv() {
      return reads.shift() ?? null;
    },
    ipcSend(_fd: number, frame: string) {
      sent = frame;
      return true;
    },
    closeFd() {},
  };

  expect(installInheritedNodeIpc(host, processObject as any)).toBe(true);
  const message = await new Promise<any>((resolve) => processObject.once("message", resolve));
  expect(message).toEqual({ text: "split-€-frame" });
  expect(processObject.env.NODE_CHANNEL_FD).toBeUndefined();

  const callbackError = await new Promise<unknown>((resolve) => {
    expect(processObject.send?.({ text: "reply-🙂" }, resolve)).toBe(true);
  });
  expect(callbackError).toBeNull();
  expect(JSON.parse(sent)).toEqual({ text: "reply-🙂" });
  processObject.disconnect?.();
  expect(processObject.connected).toBe(false);
});

test("Bun.spawn advanced IPC round-trips through a subprocess", async () => {
  const childPath = join(import.meta.dir, "fixtures", "bun-spawn-ipc-advanced-child.js");
  let resolveMessage!: (message: any) => void;
  const messagePromise = new Promise<any>((resolve) => {
    resolveMessage = resolve;
  });
  const child = Bun.spawn({
    cmd: [process.execPath, childPath],
    serialization: "advanced",
    ipc(message) {
      resolveMessage(message);
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });

  const payload: any = {
    bigint: 41n,
    map: new Map([["key", "value"]]),
    typed: new Uint16Array([3, 5]),
  };
  payload.self = payload;
  expect(child.send(payload)).toBe(true);

  const response = await messagePromise;
  expect(response.bigint).toBe(42n);
  expect(response.map).toBeInstanceOf(Map);
  expect(response.map.get("key")).toBe("value");
  expect(response.typed).toBeInstanceOf(Uint16Array);
  expect([...response.typed]).toEqual([3, 5]);
  expect(response.receivedCycle).toBe(true);
  expect(response.self).toBe(response);
  expect(await child.exited).toBe(0);
});
