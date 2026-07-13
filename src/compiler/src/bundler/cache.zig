pub const Set = struct {
    js: JavaScript,
    fs: Fs,
    json: Json,

    pub fn init(allocator: std.mem.Allocator) Set {
        return Set{
            .js = JavaScript.init(allocator),
            .fs = Fs{
                .shared_buffer = MutableString.init(allocator, 0) catch unreachable,
                .macro_shared_buffer = MutableString.init(allocator, 0) catch unreachable,
            },
            .json = Json{},
        };
    }
};
const debug = Output.scoped(.fs, .visible);
pub const Fs = struct {
    pub const Entry = struct {
        contents: string,
        fd: FD,
        /// When `contents` comes from a native plugin, this field is populated
        /// with information on how to free it.
        external_free_function: ExternalFreeFunction = .none,

        pub const ExternalFreeFunction = struct {
            ctx: ?*anyopaque,
            function: ?*const fn (?*anyopaque) callconv(.c) void,

            pub const none: ExternalFreeFunction = .{ .ctx = null, .function = null };

            pub fn call(this: *const @This()) void {
                if (this.function) |func| {
                    func(this.ctx);
                }
            }
        };

        pub fn deinit(entry: *Entry, allocator: std.mem.Allocator) void {
            if (entry.external_free_function.function) |func| {
                func(entry.external_free_function.ctx);
            } else if (entry.contents.len > 0) {
                allocator.free(entry.contents);
                entry.contents = "";
            }
        }

        pub fn closeFD(entry: *Entry) ?bun.sys.Error {
            if (entry.fd.isValid()) {
                defer entry.fd = .invalid;
                return entry.fd.closeAllowingBadFileDescriptor(@returnAddress());
            }
            return null;
        }
    };

    shared_buffer: MutableString,
    macro_shared_buffer: MutableString,

    use_alternate_source_cache: bool = false,
    stream: bool = false,

    // When we are in a macro, the shared buffer may be in use by the in-progress macro.
    // so we have to dynamically switch it out.
    pub inline fn sharedBuffer(this: *Fs) *MutableString {
        return if (!this.use_alternate_source_cache)
            &this.shared_buffer
        else
            &this.macro_shared_buffer;
    }

    /// When we need to suspend/resume something that has pointers into the shared buffer, we need to
    /// switch out the shared buffer so that it is not in use
    /// The caller must
    pub fn resetSharedBuffer(this: *Fs, buffer: *MutableString) void {
        if (buffer == &this.shared_buffer) {
            this.shared_buffer = MutableString.initEmpty(bun.default_allocator);
        } else if (buffer == &this.macro_shared_buffer) {
            this.macro_shared_buffer = MutableString.initEmpty(bun.default_allocator);
        } else {
            bun.unreachablePanic("resetSharedBuffer: invalid buffer", .{});
        }
    }

    pub fn deinit(c: *Fs) void {
        var iter = c.entries.iterator();
        while (iter.next()) |entry| {
            entry.value.deinit(c.entries.allocator);
        }
        c.entries.deinit();
    }

    pub fn readFileShared(
        this: *Fs,
        _fs: *fs.FileSystem,
        path: [:0]const u8,
        cached_file_descriptor: ?FD,
        shared: *MutableString,
    ) !Entry {
        _ = this;
        _ = _fs;
        _ = cached_file_descriptor;
        _ = shared;
        const contents = try std.Io.Dir.cwd().readFileAlloc(
            std.Io.Threaded.global_single_threaded.io(),
            path,
            bun.default_allocator,
            .unlimited,
        );
        return .{ .contents = contents, .fd = .invalid };
    }

    pub fn readFile(
        c: *Fs,
        _fs: *fs.FileSystem,
        path: string,
        dirname_fd: FD,
        comptime use_shared_buffer: bool,
        _file_handle: ?FD,
    ) !Entry {
        return c.readFileWithAllocator(bun.default_allocator, _fs, path, dirname_fd, use_shared_buffer, _file_handle);
    }

    pub fn readFileWithAllocator(
        c: *Fs,
        allocator: std.mem.Allocator,
        _fs: *fs.FileSystem,
        path: string,
        dirname_fd: FD,
        comptime use_shared_buffer: bool,
        _file_handle: ?FD,
    ) !Entry {
        _ = c;
        _ = _fs;
        _ = dirname_fd;
        _ = use_shared_buffer;
        _ = _file_handle;
        const contents = try std.Io.Dir.cwd().readFileAlloc(
            std.Io.Threaded.global_single_threaded.io(),
            path,
            allocator,
            .unlimited,
        );
        return .{ .contents = contents, .fd = .invalid };
    }
};

pub const Css = struct {
    pub const Entry = struct {};
    pub const Result = struct {
        ok: bool,
        value: void,
    };
    pub fn parse(_: *@This(), _: *logger.Log, _: logger.Source) !Result {
        Global.notimpl();
    }
};

pub const JavaScript = struct {
    pub const Result = js_ast.Result;

    pub fn init(_: std.mem.Allocator) JavaScript {
        return JavaScript{};
    }
    // For now, we're not going to cache JavaScript ASTs.
    // It's probably only relevant when bundling for production.
    pub fn parse(
        _: *const @This(),
        allocator: std.mem.Allocator,
        opts: js_parser.Parser.Options,
        defines: *Define,
        log: *logger.Log,
        source: *const logger.Source,
    ) anyerror!?js_ast.Result {
        var temp_log = logger.Log.init(allocator);
        temp_log.level = log.level;
        var parser = js_parser.Parser.init(opts, &temp_log, source, defines, allocator) catch {
            temp_log.appendToMaybeRecycled(log, source) catch {};
            return null;
        };

        const result = parser.parse() catch |err| {
            if (temp_log.errors == 0) {
                log.addRangeError(source, parser.lexer.range(), @errorName(err)) catch unreachable;
            }

            temp_log.appendToMaybeRecycled(log, source) catch {};
            return null;
        };

        if (temp_log.errors > 0) {
            temp_log.appendToMaybeRecycled(log, source) catch {};
            return null;
        }
        temp_log.appendToMaybeRecycled(log, source) catch {};
        return switch (result) {
            .ast => result,
            .already_bundled, .cached => null,
        };
    }

    pub fn scan(
        _: *@This(),
        allocator: std.mem.Allocator,
        scan_pass_result: *js_parser.ScanPassResult,
        opts: js_parser.Parser.Options,
        defines: *Define,
        log: *logger.Log,
        source: *const logger.Source,
    ) anyerror!void {
        if (strings.trim(source.contents, "\n\t\r ").len == 0) {
            return;
        }

        var temp_log = logger.Log.init(allocator);
        defer temp_log.appendToMaybeRecycled(log, source) catch {};

        var parser = js_parser.Parser.init(opts, &temp_log, source, defines, allocator) catch return;

        return try parser.scanImports(scan_pass_result);
    }
};

pub const Json = struct {
    pub fn init(_: std.mem.Allocator) Json {
        return Json{};
    }
    fn parse(_: *@This(), log: *logger.Log, source: *const logger.Source, allocator: std.mem.Allocator, comptime func: anytype, comptime force_utf8: bool) anyerror!?js_ast.Expr {
        var temp_log = logger.Log.init(allocator);
        defer {
            temp_log.appendToMaybeRecycled(log, source) catch {};
        }
        return func(source, &temp_log, allocator, force_utf8) catch handler: {
            break :handler null;
        };
    }
    pub fn parseJSON(cache: *@This(), log: *logger.Log, source: *const logger.Source, allocator: std.mem.Allocator, mode: enum { json, jsonc }, comptime force_utf8: bool) anyerror!?js_ast.Expr {
        // tsconfig.* and jsconfig.* files are JSON files, but they are not valid JSON files.
        // They are JSON files with comments and trailing commas.
        // Sometimes tooling expects this to work.
        if (mode == .jsonc) {
            return try parse(cache, log, source, allocator, json_parser.parseTSConfig, force_utf8);
        }

        return try parse(cache, log, source, allocator, json_parser.parse, force_utf8);
    }

    pub fn parsePackageJSON(cache: *@This(), log: *logger.Log, source: *const logger.Source, allocator: std.mem.Allocator, comptime force_utf8: bool) anyerror!?js_ast.Expr {
        return try parse(cache, log, source, allocator, json_parser.parseTSConfig, force_utf8);
    }

    pub fn parseTSConfig(cache: *@This(), log: *logger.Log, source: *const logger.Source, allocator: std.mem.Allocator) anyerror!?js_ast.Expr {
        return try parse(cache, log, source, allocator, json_parser.parseTSConfig, true);
    }
};

const string = []const u8;

const fs = @import("../resolver/fs.zig");
const std = @import("std");
const Define = @import("./defines.zig").Define;

const bun = @import("bun");
const Environment = bun.Environment;
const FD = bun.FD;
const FeatureFlags = bun.FeatureFlags;
const Global = bun.Global;
const MutableString = bun.MutableString;
const Output = bun.Output;
const default_allocator = bun.default_allocator;
const js_ast = bun.ast;
const js_parser = bun.js_parser;
const json_parser = bun.json;
const logger = bun.logger;
const strings = bun.strings;
