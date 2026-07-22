import { afterEach, describe, expect, test } from "bun:test";
import fsPromises from "node:fs/promises";
import { createWriteStream, existsSync, mkdtempSync, readFile, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SQL,
  arrayBufferViewHasBuffer,
  bindgen,
  crash_handler,
  fs as internalFs,
  fsStreamInternals,
  getEventLoopStats,
  timerInternals,
  upgrade_test_helpers,
} from "bun:internal-for-testing";

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("internal runtime bindings", () => {
  test("bindgen performs WebIDL conversion and Zig arithmetic", () => {
    expect(bindgen.add(5, 3)).toBe(8);
    expect(bindgen.add(undefined, "32")).toBe(32);
    expect(bindgen.add(5_555_555_555, 0)).toBe(1_260_588_259);
    expect(() => bindgen.add(2_147_483_647, 1)).toThrow("Integer overflow while adding");
    expect(() => bindgen.add(1n, 0)).toThrow("Conversion from 'BigInt' to 'number' is not allowed");

    expect(bindgen.requiredAndOptionalArg(false)).toBe(123_498);
    expect(bindgen.requiredAndOptionalArg(true, 10, 5, 2)).toBe(-30);
    expect(bindgen.requiredAndOptionalArg(true, null, 5, 2)).toBe(123_463);
    expect(() => bindgen.requiredAndOptionalArg(false, 0, 101)).toThrow(
      "Value 101 is outside the range [0, 100]",
    );
  });

  test("internal test binding delegates to the process binding cache", () => {
    const { internalBinding } = require("internal/test/binding");
    expect(internalBinding("http_parser")).toBe(process.binding("http_parser"));
    expect(internalBinding("timers")).toBe(process.binding("timers"));
    expect(typeof internalBinding("timers").getLibuvNow()).toBe("number");
    expect(() => internalBinding("definitely_missing")).toThrow("No such module");
  });

  test("test-facing helpers expose production fs, SQL, and JSC behavior", () => {
    expect(internalFs).toBe(fsPromises);
    expect(SQL).toBe(Bun.SQL);

    const directory = mkdtempSync(join(tmpdir(), "cottontail-internal-fs-"));
    temporaryDirectories.push(directory);
    const stream = createWriteStream(join(directory, "stream.txt"));
    expect(fsStreamInternals.writeStreamFastPath(stream)).toBe(stream);
    stream.destroy();

    for (const length of [0, 48, 96, 1024]) {
      for (const view of [
        new Uint8Array(length),
        new Uint16Array(length / 2),
        new Uint32Array(length / 4),
        new Float32Array(length / 4),
        new Float64Array(length / 8),
        Buffer.alloc(length),
        Buffer.allocUnsafeSlow(length),
      ]) {
        expect(arrayBufferViewHasBuffer(view)).toBe(false);
        void view.buffer;
        expect(arrayBufferViewHasBuffer(view)).toBe(true);
      }
    }

    const existingBuffer = new ArrayBuffer(8);
    expect(arrayBufferViewHasBuffer(new Uint8Array(existingBuffer))).toBe(true);
    expect(arrayBufferViewHasBuffer(new DataView(existingBuffer))).toBe(true);
  });

  test("process._getActiveRequests returns live native request objects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cottontail-active-requests-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "request.txt");
    writeFileSync(filename, "active request");

    const readFinished = Promise.withResolvers<void>();
    readFile(filename, error => error ? readFinished.reject(error) : readFinished.resolve());
    const fsRequest = process._getActiveRequests().find(
      request => request?.constructor?.name === "FSReqCallback",
    );
    expect(fsRequest).toBeDefined();
    expect(process._getActiveRequests()).toContain(fsRequest);
    await readFinished.promise;
    expect(process._getActiveRequests()).not.toContain(fsRequest);

    const nativeAttempt = cottontail.tcpSocketConnectStart(9, "192.0.2.1", 4);
    expect(nativeAttempt.type).toBe("TCPConnectWrap");
    expect(process._getActiveRequests()).toContain(nativeAttempt);
    expect(cottontail.tcpSocketConnectCancel(nativeAttempt.id)).toBe(true);
    expect(process._getActiveRequests()).not.toContain(nativeAttempt);
  });

  test("upgrade and crash helpers expose platform behavior", () => {
    upgrade_test_helpers.openTempDirWithoutSharingDelete();
    upgrade_test_helpers.closeTempDirHandle();

    if (process.platform === "darwin") {
      expect(crash_handler.getMachOImageZeroOffset()).toBeGreaterThan(0);
    } else {
      expect(crash_handler.getMachOImageZeroOffset()).toBeUndefined();
    }
    for (const name of ["segfault", "panic", "rootError", "outOfMemory", "raiseIgnoringPanicHandler"]) {
      expect(typeof crash_handler[name]).toBe("function");
    }
  });

  test("runtime clocks and event-loop counters are native and monotonic", async () => {
    const timerBefore = timerInternals.timerClockMs();
    const uptimeBefore = process.uptime();
    await Bun.sleep(2);
    expect(timerInternals.timerClockMs()).toBeGreaterThanOrEqual(timerBefore);
    expect(process.uptime()).toBeGreaterThanOrEqual(uptimeBefore);

    const stats = getEventLoopStats();
    expect(Number.isFinite(stats.activeTasks)).toBe(true);
    expect(Number.isFinite(stats.concurrentRef)).toBe(true);
    expect(Number.isFinite(stats.numPolls)).toBe(true);
    expect(Array.isArray(process.getActiveResourcesInfo())).toBe(true);
  });

  test("process reports contain live native diagnostics and write valid JSON", () => {
    const report = process.report.getReport();
    expect(report.header.reportVersion).toBe(3);
    expect(report.header.threadId).toBeGreaterThan(0);
    expect(report.header.cpus.length).toBeGreaterThan(0);
    expect(report.resourceUsage.total_memory).toBeGreaterThan(0);
    expect(report.javascriptHeap.totalCommittedMemory).toBeGreaterThanOrEqual(0);
    expect(report.libuv.length).toBeGreaterThan(0);
    expect(report.nativeStack.length).toBeGreaterThan(0);
    expect(report.sharedObjects.length).toBeGreaterThan(0);
    expect(Array.isArray(report.workers)).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), "cottontail-report-"));
    temporaryDirectories.push(directory);
    const previousDirectory = process.report.directory;
    const previousFilename = process.report.filename;
    try {
      process.report.directory = directory;
      process.report.filename = "";
      const filename = process.report.writeReport();
      expect(filename.startsWith(directory)).toBe(true);
      expect(existsSync(filename)).toBe(true);
      expect(JSON.parse(readFileSync(filename, "utf8")).header.reportVersion).toBe(3);
    } finally {
      process.report.directory = previousDirectory;
      process.report.filename = previousFilename;
    }
  });
});
