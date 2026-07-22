import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindgen,
  crash_handler,
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
