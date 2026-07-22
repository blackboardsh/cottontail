const std = @import("std");
const host = @import("host.zig");

const c = @cImport({
    @cInclude("jsc_runner.h");
});

extern fn ct_jsc_runtime_emit_process_shutdown(
    runtime: *c.CtJscRuntime,
    include_before_exit: c_int,
    error_out: [*c][*c]u8,
) c_int;
extern fn ct_jsc_runtime_had_fatal_exception(runtime: *c.CtJscRuntime) c_int;

pub const Runtime = struct {
    io: std.Io,
    allocator: std.mem.Allocator,
    handle: *c.CtJscRuntime,
    max_script_size: usize = 64 * 1024 * 1024,

    pub fn init(io: std.Io, allocator: std.mem.Allocator) !Runtime {
        return initWithStackSize(io, allocator, 0);
    }

    pub fn initWithStackSize(io: std.Io, allocator: std.mem.Allocator, stack_size: usize) !Runtime {
        const handle = c.ct_jsc_runtime_create_with_stack_size(stack_size) orelse return error.RuntimeInitFailed;
        host.configure(io);
        return .{
            .io = io,
            .allocator = allocator,
            .handle = handle,
        };
    }

    pub fn deinit(self: *Runtime) void {
        c.ct_jsc_runtime_destroy(self.handle);
    }

    pub fn setArgs(self: *Runtime, args: []const [:0]const u8) !void {
        const empty_exec_args: [0][:0]const u8 = .{};
        try self.setProcessArgs(args, if (args.len > 0) 1 else 0, empty_exec_args[0..]);
    }

    pub fn setExitCleanupPath(self: *Runtime, path: [:0]const u8) !void {
        if (c.ct_jsc_runtime_set_exit_cleanup_path(self.handle, path.ptr) != 0) {
            return error.ExitCleanupPathFailed;
        }
    }

    pub fn setProcessArgs(
        self: *Runtime,
        args: []const [:0]const u8,
        user_arg_offset: usize,
        exec_args: []const [:0]const u8,
    ) !void {
        const arg_ptrs = try self.allocator.alloc([*c]const u8, args.len);
        defer self.allocator.free(arg_ptrs);
        for (args, 0..) |arg, index| {
            arg_ptrs[index] = arg.ptr;
        }
        const exec_arg_ptrs = try self.allocator.alloc([*c]const u8, exec_args.len);
        defer self.allocator.free(exec_arg_ptrs);
        for (exec_args, 0..) |arg, index| {
            exec_arg_ptrs[index] = arg.ptr;
        }

        var eval_error: [*c]u8 = null;
        const argv_ptr = if (arg_ptrs.len == 0)
            @as([*c]const [*c]const u8, null)
        else
            @as([*c]const [*c]const u8, @ptrCast(arg_ptrs.ptr));
        const exec_argv_ptr = if (exec_arg_ptrs.len == 0)
            @as([*c]const [*c]const u8, null)
        else
            @as([*c]const [*c]const u8, @ptrCast(exec_arg_ptrs.ptr));

        if (c.ct_jsc_runtime_set_args(
            self.handle,
            args.len,
            argv_ptr,
            user_arg_offset,
            exec_args.len,
            exec_argv_ptr,
            &eval_error,
        ) != 0) {
            defer if (eval_error != null) {
                c.ct_jsc_string_free(eval_error);
            };

            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Failed to set cottontail.args");
            }

            return error.SetArgsFailed;
        }
    }

    pub fn setEmbeddedSourceMap(
        self: *Runtime,
        source_map: []const u8,
        bundle_path: []const u8,
    ) !void {
        const map_literal = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .string = source_map },
            .{},
        );
        defer self.allocator.free(map_literal);
        const path_literal = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .string = bundle_path },
            .{},
        );
        defer self.allocator.free(path_literal);
        const setup_source = try std.fmt.allocPrint(
            self.allocator,
            "globalThis.__cottontailBundleSourceMapData={s};globalThis.__cottontailBundlePath={s};",
            .{ map_literal, path_literal },
        );
        defer self.allocator.free(setup_source);

        var eval_error: [*c]u8 = null;
        const filename = "cottontail:standalone-source-map";
        if (c.ct_jsc_runtime_eval(
            self.handle,
            setup_source.ptr,
            setup_source.len,
            filename,
            &eval_error,
        ) != 0) {
            defer if (eval_error != null) c.ct_jsc_string_free(eval_error);
            if (eval_error != null) self.writeStderrLine(std.mem.span(eval_error));
            return error.SourceMapSetupFailed;
        }
    }

    pub fn setExternalSourceMap(
        self: *Runtime,
        source_map_path: []const u8,
        bundle_path: []const u8,
    ) !void {
        const map_literal = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .string = source_map_path },
            .{},
        );
        defer self.allocator.free(map_literal);
        const path_literal = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .string = bundle_path },
            .{},
        );
        defer self.allocator.free(path_literal);
        const setup_source = try std.fmt.allocPrint(
            self.allocator,
            "globalThis.__cottontailBundleSourceMap={s};globalThis.__cottontailBundlePath={s};",
            .{ map_literal, path_literal },
        );
        defer self.allocator.free(setup_source);

        var eval_error: [*c]u8 = null;
        const filename = "cottontail:external-source-map";
        if (c.ct_jsc_runtime_eval(
            self.handle,
            setup_source.ptr,
            setup_source.len,
            filename,
            &eval_error,
        ) != 0) {
            defer if (eval_error != null) c.ct_jsc_string_free(eval_error);
            if (eval_error != null) self.writeStderrLine(std.mem.span(eval_error));
            return error.SourceMapSetupFailed;
        }
    }

    pub fn setStandaloneFiles(self: *Runtime, files: []const u8) !void {
        var eval_error: [*c]u8 = null;
        if (c.ct_jsc_runtime_set_standalone_files(
            self.handle,
            files.ptr,
            files.len,
            &eval_error,
        ) != 0) {
            defer if (eval_error != null) c.ct_jsc_string_free(eval_error);
            if (eval_error != null) self.writeStderrLine(std.mem.span(eval_error));
            return error.StandaloneGraphSetupFailed;
        }
    }

    pub fn runFile(self: *Runtime, script_path: [:0]const u8) u8 {
        const source = std.Io.Dir.cwd().readFileAlloc(
            self.io,
            script_path,
            self.allocator,
            .limited(self.max_script_size),
        ) catch |err| {
            self.writeLoadError(script_path, err);
            return 1;
        };

        return self.runSource(source, script_path);
    }

    pub fn runSource(self: *Runtime, source: []const u8, filename: [:0]const u8) u8 {
        const source_z = self.allocator.alloc(u8, source.len + 1) catch {
            self.writeStderrLine("cottontail: out of memory preparing script source");
            return 1;
        };
        @memcpy(source_z[0..source.len], source);
        source_z[source.len] = 0;

        var eval_error: [*c]u8 = null;

        const eval_status = c.ct_jsc_runtime_eval(self.handle, source_z.ptr, source.len, filename.ptr, &eval_error);
        if (eval_status != 0) {
            defer if (eval_error != null) {
                c.ct_jsc_string_free(eval_error);
            };

            if (eval_status == -13) return 13;
            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Unknown JavaScript exception");
            }

            const routed_fatal = ct_jsc_runtime_had_fatal_exception(self.handle) != 0;
            const shutdown_status = self.emitProcessShutdown(false);
            if (shutdown_status != 0) return shutdown_status;
            const exit_code: u8 = @intCast(c.ct_jsc_runtime_exit_code(self.handle));
            return if (routed_fatal or exit_code != 0) exit_code else 1;
        }

        const shutdown_status = self.emitProcessShutdown(true);
        if (shutdown_status != 0) return shutdown_status;
        return @intCast(c.ct_jsc_runtime_exit_code(self.handle));
    }

    fn emitProcessShutdown(self: *Runtime, include_before_exit: bool) u8 {
        if (!include_before_exit) return self.emitNativeProcessShutdown(false);

        const shutdown_source =
            \\(() => {
            \\  const hiddenGlobals = [
            \\    "SharedArrayBuffer", "cottontail", "__ctUnhandledRejection", "__cottontailMarkSharedArrayBuffer",
            \\    "__ctDone", "__ctError", "__ctTopLevelPromise", "__cottontailSuppressAsyncHookPromise",
            \\    "process", "URLSearchParams", "URL", "TextEncoder", "TextDecoder",
            \\    "__cottontailObjectURLRegistry", "__cottontailObjectURLNextId", "Buffer", "Bun",
            \\    "__cottontailTimersInstalled", "requestAnimationFrame", "cancelAnimationFrame",
            \\    "__cottontailRegisterSpawnListener", "__cottontailHasActiveHandles", "__cottontailRunLoopTick",
            \\    "Worker", "__cottontailProxyRegistry", "__cottontailBunModuleMocks", "DOMException", "Event",
            \\    "EventTarget", "AbortSignal", "AbortController", "Headers", "Request", "Response",
            \\    "__cottontailFileWatchers", "__cottontailDiagnosticsChannels", "__cottontailImportModule",
            \\    "__cottontailBuiltinModules", "Blob", "File", "crypto", "fetch", "structuredClone", "atob", "btoa",
            \\    "performance", "self", "global", "MessagePort", "MessageChannel", "__cottontailFdWatchListeners",
            \\    "__cottontailFdWatchHandlerInstalled", "__cottontailTlsListeners", "__cottontailWorkerData",
            \\    "__cottontailEnvironmentData", "__cottontailWorkerResourceLimits", "__cottontailWorkerThreadName",
            \\    "__cottontailEncodeWorkerMessage", "__cottontailDecodeWorkerMessage", "parentPort", "workerData"
            \\  ];
            \\  const descriptorFields = ["value", "writable", "get", "set", "enumerable", "configurable"];
            \\  for (let index = 0; index < hiddenGlobals.length; index += 1) {
            \\    const name = hiddenGlobals[index];
            \\    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
            \\    if (!descriptor || descriptor.enumerable !== true) continue;
            \\    const clean = Object.create(null);
            \\    for (let fieldIndex = 0; fieldIndex < descriptorFields.length; fieldIndex += 1) {
            \\      const field = descriptorFields[fieldIndex];
            \\      if (Object.prototype.hasOwnProperty.call(descriptor, field)) clean[field] = descriptor[field];
            \\    }
            \\    clean.enumerable = false;
            \\    try { Object.defineProperty(globalThis, name, clean); } catch {}
            \\  }
            \\})();
        ;
        var eval_error: [*c]u8 = null;
        if (c.ct_jsc_runtime_eval(self.handle, shutdown_source.ptr, shutdown_source.len, "cottontail:shutdown", &eval_error) != 0) {
            defer if (eval_error != null) {
                c.ct_jsc_string_free(eval_error);
            };

            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Unknown JavaScript exception during process shutdown");
            }

            return 1;
        }
        return self.emitNativeProcessShutdown(true);
    }

    fn emitNativeProcessShutdown(self: *Runtime, include_before_exit: bool) u8 {
        var lifecycle_error: [*c]u8 = null;
        if (ct_jsc_runtime_emit_process_shutdown(
            self.handle,
            @intFromBool(include_before_exit),
            &lifecycle_error,
        ) != 0) {
            defer if (lifecycle_error != null) c.ct_jsc_string_free(lifecycle_error);
            if (lifecycle_error != null) {
                self.writeStderrLine(std.mem.span(lifecycle_error));
            } else {
                self.writeStderrLine("Unknown JavaScript exception during process shutdown");
            }
            const exit_code: u8 = @intCast(c.ct_jsc_runtime_exit_code(self.handle));
            const routed_fatal = ct_jsc_runtime_had_fatal_exception(self.handle) != 0;
            return if (routed_fatal or exit_code != 0) exit_code else 1;
        }
        return 0;
    }

    pub fn tick(self: *Runtime) !void {
        var eval_error: [*c]u8 = null;
        if (c.ct_jsc_runtime_tick(self.handle, &eval_error) != 0) {
            defer if (eval_error != null) {
                c.ct_jsc_string_free(eval_error);
            };

            if (eval_error != null) {
                self.writeStderrLine(std.mem.span(eval_error));
            } else {
                self.writeStderrLine("Unknown JavaScript exception during Cottontail tick");
            }

            return error.TickFailed;
        }
    }

    pub fn enableSamplingProfiler(self: *Runtime) bool {
        return c.ct_jsc_runtime_enable_sampling_profiler(self.handle);
    }

    pub fn takeSamplingProfile(self: *Runtime) !?[]u8 {
        const profile = c.ct_jsc_runtime_take_sampling_profiler(self.handle);
        if (profile == null) return null;
        defer c.ct_jsc_string_free(profile);
        return try self.allocator.dupe(u8, std.mem.span(profile));
    }

    pub fn takeHeapSnapshot(self: *Runtime, gc_debugging: bool) !?[]u8 {
        const snapshot = c.ct_jsc_runtime_take_heap_snapshot(self.handle, gc_debugging);
        if (snapshot == null) return null;
        defer c.ct_jsc_string_free(snapshot);
        return try self.allocator.dupe(u8, std.mem.span(snapshot));
    }

    fn writeLoadError(self: *Runtime, script_path: []const u8, err: anyerror) void {
        var stderr_buffer: [1024]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(self.io, &stderr_buffer);
        const stderr = &stderr_writer.interface;

        stderr.print(
            "cottontail: failed to load script {s}: {s}\n",
            .{ script_path, @errorName(err) },
        ) catch {};
        stderr.flush() catch {};
    }

    fn writeStderrLine(self: *Runtime, message: []const u8) void {
        var stderr_buffer: [1024]u8 = undefined;
        var stderr_writer = std.Io.File.stderr().writer(self.io, &stderr_buffer);
        const stderr = &stderr_writer.interface;

        stderr.print("{s}\n", .{message}) catch {};
        stderr.flush() catch {};
    }
};
