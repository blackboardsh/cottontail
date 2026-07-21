import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import EventEmitter from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalExitCode = process.exitCode;
const originalUmask = process.platform === "win32" ? 0 : process.umask();

function expectErrorCode(callback: () => unknown, code: string) {
  try {
    callback();
  } catch (error) {
    expect((error as Error & { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

afterEach(() => {
  process.exitCode = originalExitCode;
  if (process.platform !== "win32") process.umask(originalUmask);
  process.setSourceMapsEnabled(false);
});

describe("node:process behavior", () => {
  test("reports the supported Node contract and Bun compatibility", () => {
    expect(process.version).toBe("v24.11.1");
    expect(process.versions.node).toBe("24.11.1");
    expect(process.versions.cottontail).toBeString();
    expect(process.release.name).toBe("node");
    expect(process.release.sourceUrl).toContain(`/bun-v${process.versions.bun}/bun-`);
    expect(process.isBun).toBe(true);
  });

  test("is an EventEmitter with Node listener validation", () => {
    const prototype = Object.getPrototypeOf(process);
    expect(prototype).toBeInstanceOf(EventEmitter);
    expect(process).toBeInstanceOf(process.constructor as typeof EventEmitter);
    expectErrorCode(() => process.on("invalid-listener", null as never), "ERR_INVALID_ARG_TYPE");
  });

  test("initializes supplied process constructor receivers", () => {
    const receiver = { ...process };
    const result = (process.constructor as unknown as { call(value: object): object }).call(receiver);
    expect(result).toBe(receiver);
    expect(Object.getPrototypeOf(result)).toBe(Object.getPrototypeOf(process));
    expect(result).toBeInstanceOf(EventEmitter);
  });

  test("tracks the CommonJS main module and permits an override", () => {
    const directory = mkdtempSync(join(tmpdir(), "cottontail-process-main-module-"));
    const fixture = join(directory, "fixture.cjs");
    try {
      writeFileSync(fixture, `
        process.mainModule = process.mainModule;
        module.exports = { loaded: true };
        if (process.mainModule !== require.main) throw new Error("main module mismatch");
        if (process.mainModule.exports !== module.exports) throw new Error("main exports mismatch");
        process.mainModule = { overridden: true };
        if (process.mainModule === require.main) throw new Error("main module override failed");
      `);
      const result = spawnSync(process.execPath, [fixture], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("validates and preserves primitive dlopen exports", () => {
    const host = (globalThis as typeof globalThis & {
      cottontail: { nativeAddonLoad(path: string, exports: object): object };
    }).cottontail;
    const originalLoad = host.nativeAddonLoad;
    const calls: object[] = [];
    host.nativeAddonLoad = (_path, exports) => {
      calls.push(exports);
      return exports;
    };
    try {
      expect(() => process.dlopen({ exports: null } as never, "addon.node")).toThrow("null is not an object");
      expect(() => process.dlopen({ exports: undefined } as never, "addon.node")).toThrow("undefined is not an object");
      const module = { exports: "primitive" };
      process.dlopen(module as never, "addon.node");
      expect(module.exports).toBe("primitive");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBeInstanceOf(String);
    } finally {
      host.nativeAddonLoad = originalLoad;
    }
  });

  test("exposes the real X509 process binding predicate", () => {
    const binding = (process as typeof process & {
      binding(name: "crypto/x509"): { isX509Certificate(value: unknown): boolean };
    }).binding("crypto/x509");
    const certificate = new X509Certificate(readFileSync(join(
      import.meta.dir,
      "../../compat/upstream/bun/v1.3.10/test/js/node/tls/fixtures/agent1-cert.pem",
    )));
    expect(binding.isX509Certificate(certificate)).toBe(true);
    expect(binding.isX509Certificate(Object.create(X509Certificate.prototype))).toBe(false);
    expect(binding.isX509Certificate({})).toBe(false);
  });

  test("validates hrtime tuples", () => {
    expect(process.hrtime()).toHaveLength(2);
    expect(typeof process.hrtime.bigint()).toBe("bigint");
    expectErrorCode(() => process.hrtime(1 as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.hrtime([] as never), "ERR_OUT_OF_RANGE");
    expectErrorCode(() => process.hrtime([1] as never), "ERR_OUT_OF_RANGE");
    expectErrorCode(() => process.hrtime([1, 2, 3] as never), "ERR_OUT_OF_RANGE");
  });

  test("validates CPU usage deltas", () => {
    for (const method of [process.cpuUsage, process.threadCpuUsage]) {
      const usage = method();
      expect(usage.user).toBeGreaterThanOrEqual(0);
      expect(usage.system).toBeGreaterThanOrEqual(0);
      expectErrorCode(() => method(1 as never), "ERR_INVALID_ARG_TYPE");
      expectErrorCode(() => method({} as never), "ERR_INVALID_ARG_TYPE");
      expectErrorCode(() => method({ user: -1, system: 0 }), "ERR_INVALID_ARG_VALUE");
      expectErrorCode(() => method({ user: 0, system: Infinity }), "ERR_INVALID_ARG_VALUE");
    }
  });

  test("validates and normalizes exitCode", () => {
    process.exitCode = "2" as never;
    expect(process.exitCode).toBe(2);
    process.exitCode = null as never;
    expect(process.exitCode).toBeUndefined();
    expectErrorCode(() => { process.exitCode = "potato" as never; }, "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => { process.exitCode = 1.2; }, "ERR_OUT_OF_RANGE");
    expectErrorCode(() => { process.exitCode = Number.NaN; }, "ERR_OUT_OF_RANGE");
    expect(Object.getOwnPropertyDescriptor(process, "exitCode")?.configurable).toBe(false);
  });

  test.skipIf(process.platform === "win32")("accepts octal umasks and rejects invalid masks", () => {
    process.umask("10664" as never);
    expect(process.umask()).toBe(0o664);
    expectErrorCode(() => process.umask("999" as never), "ERR_INVALID_ARG_VALUE");
    expectErrorCode(() => process.umask(null as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.umask(-1), "ERR_OUT_OF_RANGE");
  });

  test.skipIf(process.platform === "win32")("validates POSIX credential arguments", () => {
    expectErrorCode(() => process.setuid({} as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.setgid(-1), "ERR_OUT_OF_RANGE");
    expectErrorCode(() => process.setgroups(undefined as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.setgroups([1, -1]), "ERR_OUT_OF_RANGE");
    expectErrorCode(
      () => process.setuid("cottontail-user-that-does-not-exist"),
      "ERR_UNKNOWN_CREDENTIAL",
    );
    expectErrorCode(() => process.initgroups(undefined as never, 0), "ERR_INVALID_ARG_TYPE");
  });

  test("validates source-map state", () => {
    process.setSourceMapsEnabled(true);
    expect(process.sourceMapsEnabled).toBe(true);
    expectErrorCode(() => process.setSourceMapsEnabled(1 as never), "ERR_INVALID_ARG_TYPE");
  });

  test("reports structured chdir errors", () => {
    const source = process.cwd();
    const destination = join(source, `cottontail-process-missing-${process.pid}`);
    try {
      process.chdir(destination);
      throw new Error("Expected chdir to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ENOENT",
        syscall: "chdir",
        path: source,
        dest: destination,
      });
    }
    expect(process.cwd()).toBe(source);
  });

  test("normalizes kill arguments through the replaceable native primitive", () => {
    const processWithKill = process as typeof process & { _kill(pid: number, signal: number): unknown };
    const originalKill = processWithKill._kill;
    const calls: Array<[number, number]> = [];
    processWithKill._kill = (pid, signal) => { calls.push([pid, signal]); };
    try {
      expect(process.kill(String(process.pid) as never, 0)).toBe(true);
      expect(calls).toEqual([[process.pid, 0]]);
      expectErrorCode(() => process.kill(undefined as never), "ERR_INVALID_ARG_TYPE");
      expectErrorCode(() => process.kill(process.pid, "SIGCOTTONTAIL" as never), "ERR_UNKNOWN_SIGNAL");
    } finally {
      processWithKill._kill = originalKill;
    }
  });

  test("updates JSC timezone state without rejecting environment assignments", () => {
    const hadTimeZone = Object.hasOwn(process.env, "TZ");
    const originalTimeZone = process.env.TZ;
    try {
      process.env.TZ = "Etc/UTC";
      expect(["Etc/UTC", "UTC"]).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(() => { process.env.TZ = "Cottontail/Invalid-Time-Zone"; }).not.toThrow();
      expect(process.env.TZ).toBe("Cottontail/Invalid-Time-Zone");
    } finally {
      if (hadTimeZone) process.env.TZ = originalTimeZone;
      else delete process.env.TZ;
    }
  });

  test("supports symbol and legacy ref APIs", () => {
    const symbolRefable = {
      refs: 0,
      unrefs: 0,
      [Symbol.for("nodejs.ref")]() { this.refs += 1; },
      [Symbol.for("nodejs.unref")]() { this.unrefs += 1; },
    };
    const legacyRefable = {
      refs: 0,
      unrefs: 0,
      ref() { this.refs += 1; },
      unref() { this.unrefs += 1; },
    };
    process.ref(symbolRefable);
    process.unref(symbolRefable);
    process.ref(legacyRefable);
    process.unref(legacyRefable);
    expect([symbolRefable.refs, symbolRefable.unrefs]).toEqual([1, 1]);
    expect([legacyRefable.refs, legacyRefable.unrefs]).toEqual([1, 1]);
  });

  test("exposes an immutable allowed-flags set", () => {
    const flags = process.allowedNodeEnvironmentFlags;
    const size = flags.size;
    expect(Object.isFrozen(flags)).toBe(true);
    expect(flags.has("perf_basic_prof")).toBe(true);
    expect(flags.has("--stack-trace-limit=100")).toBe(true);
    expect(flags.has("--stack-trace-limit=-=xX_nodejs_Xx=-")).toBe(true);
    flags.add("--cottontail-invalid");
    Set.prototype.add.call(flags, "--cottontail-invalid-2");
    expect(flags.size).toBe(size);
    expect(flags.has("--cottontail-invalid")).toBe(false);
    expect(flags.has("--cottontail-invalid-2")).toBe(false);
  });

  test("provides Node environment assignment and descriptor semantics", () => {
    const key = "COTTONTAIL_PROCESS_ENV_BEHAVIOR";
    const descriptorKey = `${key}_DESCRIPTOR`;
    try {
      process.env[key] = 42 as never;
      expect(process.env[key]).toBe("42");
      process.env[key] = undefined as never;
      expect(process.env[key]).toBe("undefined");
      expect(() => { process.env[Symbol("key") as never] = "value"; }).toThrow(TypeError);
      expect(() => { process.env[key] = Symbol("value") as never; }).toThrow(TypeError);
      expectErrorCode(() => Object.defineProperty(process.env, descriptorKey, { value: "invalid" }), "ERR_INVALID_OBJECT_DEFINE_PROPERTY");
      Object.defineProperty(process.env, descriptorKey, {
        value: 7,
        configurable: true,
        writable: true,
        enumerable: true,
      });
      expect(process.env[descriptorKey]).toBe("7");
    } finally {
      delete process.env[key];
      delete process.env[descriptorKey];
    }
  });

  test("validates uncaught-exception capture callbacks", () => {
    expectErrorCode(() => process.setUncaughtExceptionCaptureCallback(42 as never), "ERR_INVALID_ARG_TYPE");
  });

  test("validates process-owned module and exec APIs", () => {
    expectErrorCode(() => process.getBuiltinModule(1 as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.execve(1 as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.execve(process.execPath, "args" as never), "ERR_INVALID_ARG_TYPE");
    expectErrorCode(() => process.execve(process.execPath, [1 as never]), "ERR_INVALID_ARG_VALUE");
    expectErrorCode(
      () => process.execve(process.execPath, [], { COTTONTAIL_INVALID: 1 as never }),
      "ERR_INVALID_ARG_VALUE",
    );
  });

  test("validates finalization targets and unregisters safely", () => {
    expectErrorCode(() => process.finalization.register(undefined as never, () => {}), "ERR_INVALID_ARG_TYPE");
    const target = {};
    process.finalization.register(target, () => {});
    process.finalization.unregister(target);
    process.finalization.unregister(target);
  });

  test("supports warning overloads and validation", async () => {
    const warnings: Error[] = [];
    let warningOutput = "";
    const stderr = process.stderr as typeof process.stderr & {
      write(chunk: unknown, encoding?: unknown, callback?: unknown): boolean;
    };
    const originalWrite = stderr.write;
    stderr.write = (chunk: unknown) => {
      warningOutput += String(chunk);
      return true;
    };
    let resolveWarning: (() => void) | undefined;
    const delivered = new Promise<void>((resolve) => { resolveWarning = resolve; });
    const listener = (warning: Error) => {
      warnings.push(warning);
      resolveWarning?.();
    };
    process.on("warning", listener);
    try {
      process.emitWarning("detail warning", { type: "CustomWarning", code: "W_TEST", detail: "detail" });
      await delivered;
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({ name: "CustomWarning", code: "W_TEST", detail: "detail" });
      expect(warningOutput).toContain(`(node:${process.pid}) [W_TEST] CustomWarning: detail warning`);
      expect(warningOutput).toContain("detail");
      expectErrorCode(() => process.emitWarning(1 as never), "ERR_INVALID_ARG_TYPE");
    } finally {
      process.off("warning", listener);
      stderr.write = originalWrite;
    }
  });

  test("loads dotenv files without replacing existing variables", () => {
    const directory = mkdtempSync(join(tmpdir(), "cottontail-process-"));
    const path = join(directory, ".env");
    const previous = process.env.COTTONTAIL_PROCESS_EXISTING;
    try {
      process.env.COTTONTAIL_PROCESS_EXISTING = "original";
      delete process.env.COTTONTAIL_PROCESS_LOADED;
      writeFileSync(path, "COTTONTAIL_PROCESS_EXISTING=replaced\nCOTTONTAIL_PROCESS_LOADED=loaded\n");
      process.loadEnvFile(path);
      expect(process.env.COTTONTAIL_PROCESS_EXISTING).toBe("original");
      expect(process.env.COTTONTAIL_PROCESS_LOADED).toBe("loaded");
      expect(() => process.loadEnvFile(join(directory, "missing.env"))).toThrow("ENOENT");
    } finally {
      if (previous === undefined) delete process.env.COTTONTAIL_PROCESS_EXISTING;
      else process.env.COTTONTAIL_PROCESS_EXISTING = previous;
      delete process.env.COTTONTAIL_PROCESS_LOADED;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
