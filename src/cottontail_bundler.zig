const std = @import("std");
const compiler = @import("cottontail_compiler");
const embedded_runtime_modules = @import("embedded_runtime_modules.zig");

const c_allocator = std.heap.c_allocator;

pub const RuntimeAlias = compiler.resolver.Resolver.RuntimeAlias;

pub const BundleOptions = struct {
    aliases: []const RuntimeAlias = &.{},
    conditions: []const []const u8 = &.{},
    tsconfig_override: ?[]const u8 = null,
    source_map: compiler.schema.api.SourceMapMode = .none,
    output_format: compiler.options.Format = .esm,
    target: compiler.schema.api.Target = .bun,
    loader: ?[]const u8 = null,
    external_packages: bool = false,
    include_runtime_modules: bool = false,
    inline_import_meta_properties: bool = false,
    minify_whitespace: bool = false,
    minify_identifiers: bool = false,
    minify_syntax: bool = false,
    /// Compile-time defines (parallel key/value arrays), e.g. mapping
    /// `import.meta.url` to a runtime identifier for dynamic-import target
    /// factories where the true URL (including `?query` suffixes) is only
    /// known at runtime.
    define_keys: []const []const u8 = &.{},
    define_values: []const []const u8 = &.{},
    /// `Bun.build({ reactFastRefresh: true })`: annotate JSX components with
    /// $RefreshReg$/$RefreshSig$ registration calls.
    react_fast_refresh: bool = false,
    /// `Bun.build({ external: [...] })`: import specifiers left unresolved.
    external: []const []const u8 = &.{},
    /// `Bun.build({ naming: ... })` templates (Bun's defaults when unset).
    entry_naming: []const u8 = "[dir]/[name].[ext]",
    chunk_naming: []const u8 = "./chunk-[hash].[ext]",
    asset_naming: []const u8 = "./[name]-[hash].[ext]",
    /// One-shot startup bundles (`cottontail run`) skip the bundle teardown:
    /// the process immediately evaluates the result and user-visible startup
    /// latency matters more than reclaiming a single bundle's memory.
    /// Repeated in-process bundles (Bun.build) always tear down.
    skip_teardown: bool = false,
};

/// Process-wide worker pool shared by every bundle. Passing an external pool
/// into BundleV2 keeps the (thread-owning) ThreadPool out of the per-bundle
/// arena, which is what makes freeing that arena after each bundle safe.
var shared_worker_pool: ?*compiler.ThreadPool = null;

fn sharedWorkerPool() ?*compiler.ThreadPool {
    if (shared_worker_pool) |pool| return pool;
    const pool = c_allocator.create(compiler.ThreadPool) catch return null;
    pool.* = .init(.{ .max_threads = compiler.getThreadCount() });
    shared_worker_pool = pool;
    return pool;
}

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

fn setBuildError(error_out: *?[*:0]u8, log: *const compiler.logger.Log, fallback: anyerror) void {
    for (log.msgs.items) |message| {
        if (message.kind == .err) {
            if (message.data.location) |location| {
                setError(error_out, "{s}:{}:{}: {s}", .{
                    location.file,
                    location.line + 1,
                    location.column + 1,
                    message.data.text,
                });
            } else {
                setError(error_out, "{s}", .{message.data.text});
            }
            return;
        }
    }
    setError(error_out, "JavaScript bundle failed: {s}", .{@errorName(fallback)});
}

pub fn bundleEntryPointWithOptions(
    entry_path: []const u8,
    working_dir: []const u8,
    options: BundleOptions,
    error_out: *?[*:0]u8,
) ![]u8 {
    const allocator = compiler.default_allocator;
    compiler.cli.start_time = compiler.nanoTimestamp();
    const working_dir_z = try allocator.dupeZ(u8, working_dir);
    defer allocator.free(working_dir_z);

    var transform_options = std.mem.zeroes(compiler.schema.api.TransformOptions);
    transform_options.absolute_working_dir = working_dir_z;
    transform_options.entry_points = &.{entry_path};
    transform_options.target = options.target;
    transform_options.write = false;
    transform_options.output_dir = "";
    transform_options.source_map = options.source_map;
    transform_options.conditions = options.conditions;
    transform_options.tsconfig_override = options.tsconfig_override;
    transform_options.packages = if (options.external_packages) .external else .bundle;
    transform_options.disable_hmr = true;
    transform_options.main_fields = &.{ "main", "module" };
    if (options.define_keys.len > 0) {
        transform_options.define = .{
            .keys = options.define_keys,
            .values = options.define_values,
        };
    }

    var loader_extensions: [1][]const u8 = undefined;
    var loader_values: [1]compiler.schema.api.Loader = undefined;
    if (options.loader) |loader_name| {
        const loader = compiler.options.Loader.fromString(loader_name) orelse {
            setError(error_out, "Unsupported loader: {s}", .{loader_name});
            return error.InvalidLoader;
        };
        const extension = std.fs.path.extension(entry_path);
        // For extensionless entry points, register the loader under the empty
        // extension: `Path.loader` looks entries up by the file's actual
        // extension (`""` here), so mapping ".js" would never apply and the
        // file would fall back to the `file` loader (e.g. `import("./empty-file",
        // { with: { type: "js" } })`).
        loader_extensions[0] = extension;
        // NOTE: `options.Loader` and `api.Loader` have different integer
        // values (`jsx` is 0 in one and 1 in the other), so a raw
        // `@enumFromInt(@intFromEnum(...))` cast shifts every loader by one
        // ("jsx" became invalid, "js" became jsx, ...). Use the real mapping.
        loader_values[0] = loader.toAPI();
        transform_options.loaders = .{
            .extensions = &loader_extensions,
            .loaders = &loader_values,
        };
    }

    var log = compiler.logger.Log.init(allocator);
    var transpiler = compiler.Transpiler.init(allocator, &log, transform_options, null) catch |err| {
        setBuildError(error_out, &log, err);
        log.deinit();
        return err;
    };
    defer transpiler.deinitPreservingFileSystem();
    try transpiler.fs.setTopLevelDir(working_dir_z);
    transpiler.resolver.runtime_aliases = options.aliases;

    transpiler.options.output_format = options.output_format;
    transpiler.options.source_map = compiler.options.SourceMapOption.fromApi(options.source_map);
    transpiler.options.inline_import_meta_properties = options.inline_import_meta_properties;
    transpiler.options.minify_whitespace = options.minify_whitespace;
    transpiler.options.minify_identifiers = options.minify_identifiers;
    transpiler.options.minify_syntax = options.minify_syntax;
    transpiler.options.supports_multiple_outputs = false;
    // Runtime bundling (bun run / bun test emulation): require.resolve() of
    // asset files must stay a runtime call returning the on-disk path instead
    // of becoming an additional output file (which single-output in-memory
    // bundles cannot emit).
    transpiler.options.externalize_runtime_require_resolve = true;
    // Cottontail's vendored JSC has no native `using` / `await using`
    // support; always lower them in bundles that run on this runtime.
    transpiler.options.force_lower_using = true;
    // Runtime bundles are evaluated as classic sloppy-mode scripts, so CJS
    // modules with an explicit "use strict" must keep the directive inside
    // their wrapper closures (including the entry point).
    transpiler.options.preserve_strict_directives_in_wrappers = true;
    transpiler.configureDefines() catch |err| {
        setBuildError(error_out, &log, err);
        return err;
    };
    transpiler.configureLinker();
    transpiler.resolver.opts = transpiler.options;
    transpiler.resolver.env_loader = transpiler.env;

    var reachable_files_count: usize = 0;
    var minify_duration: u64 = 0;
    var source_code_size: u64 = 0;
    var runtime_file_map: compiler.jsc.API.JSBundler.FileMap = .{};
    var runtime_file_keys: std.ArrayList([]u8) = .empty;
    defer {
        runtime_file_map.map.deinit(c_allocator);
        for (runtime_file_keys.items) |key| c_allocator.free(key);
        runtime_file_keys.deinit(c_allocator);
    }
    if (options.include_runtime_modules) {
        var iterator = try embedded_runtime_modules.Iterator.init();
        while (try iterator.next()) |entry| {
            const path = try embedded_runtime_modules.virtualPath(c_allocator, working_dir, entry.path);
            try runtime_file_keys.append(c_allocator, path);
            try runtime_file_map.map.put(c_allocator, path, entry.contents);
        }
    }
    const runtime_file_map_ptr = if (runtime_file_map.map.count() > 0) &runtime_file_map else null;
    const event_loop = compiler.jsc.AnyEventLoop.init(allocator);
    const worker_pool = sharedWorkerPool();
    var bundle: ?*compiler.bundle_v2.BundleV2 = null;
    defer if (bundle) |value| {
        if (options.skip_teardown) {
            // One-shot startup bundle: leave everything for process exit.
        } else if (worker_pool != null) {
            value.deinitFromCLI(allocator);
        } else {
            value.deinitWithoutFreeingArena();
        }
    };
    // BundleV2.init points `log.msgs.allocator` at the bundle arena, so the
    // log must be abandoned (not freed) before the arena teardown above runs;
    // message texts consumed by callers are duped out beforehand.
    defer log.msgs = std.array_list.Managed(compiler.logger.Msg).init(allocator);
    var result = compiler.bundle_v2.BundleV2.generateFromCLIReleasable(
        &transpiler,
        allocator,
        event_loop,
        false,
        &reachable_files_count,
        &minify_duration,
        &source_code_size,
        null,
        runtime_file_map_ptr,
        &bundle,
        worker_pool,
    ) catch |err| {
        setBuildError(error_out, &log, err);
        return err;
    };
    defer result.deinit();

    var saw_entry_point = false;
    for (result.output_files.items) |output_file| {
        if (output_file.output_kind != .@"entry-point" and output_file.output_kind != .chunk) continue;
        saw_entry_point = true;
        const bytes = output_file.value.asSlice();
        if (bytes.len > 0) return try c_allocator.dupe(u8, bytes);
    }

    // An empty (or comment/whitespace-only) module legitimately bundles to
    // zero bytes, e.g. `import "./empty.js"` — treat it as an empty module
    // instead of failing the bundle.
    if (saw_entry_point) return try c_allocator.dupe(u8, "");

    setError(error_out, "JavaScript bundle produced no entry point", .{});
    return error.NoEntryPointOutput;
}

pub fn bundleEntryPoint(entry_path: []const u8, working_dir: []const u8, error_out: *?[*:0]u8) ![]u8 {
    return bundleEntryPointWithOptions(entry_path, working_dir, .{}, error_out);
}

pub export fn ct_bundle_entry_point(
    entry_ptr: ?[*]const u8,
    entry_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const entry_path = if (entry_ptr) |ptr| ptr[0..entry_len] else {
        setError(error_out, "entry point is required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setError(error_out, "working directory is required", .{});
        return null;
    };

    const output = bundleEntryPoint(entry_path, working_dir, error_out) catch return null;
    out_len.* = output.len;
    return output.ptr;
}

fn parseBuildOptions(options_json: []const u8, allocator: std.mem.Allocator) !BundleOptions {
    if (options_json.len == 0) return .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, options_json, .{});
    if (parsed.value != .object) return error.InvalidOptions;
    const object = parsed.value.object;
    var options: BundleOptions = .{};

    if (object.get("format")) |value| {
        if (value == .string) {
            options.output_format = compiler.options.Format.fromString(value.string) orelse return error.InvalidFormat;
        }
    }
    if (object.get("target")) |value| {
        if (value == .string) {
            options.target = if (std.ascii.eqlIgnoreCase(value.string, "browser"))
                .browser
            else if (std.ascii.eqlIgnoreCase(value.string, "node"))
                .node
            else if (std.ascii.eqlIgnoreCase(value.string, "bun"))
                .bun
            else
                return error.InvalidTarget;
        }
    }
    if (object.get("sourcemap")) |value| switch (value) {
        .bool => |enabled| options.source_map = if (enabled) .linked else .none,
        .string => |mode| options.source_map = if (std.ascii.eqlIgnoreCase(mode, "inline"))
            .@"inline"
        else if (std.ascii.eqlIgnoreCase(mode, "external"))
            .external
        else if (std.ascii.eqlIgnoreCase(mode, "linked"))
            .linked
        else
            .none,
        else => {},
    };
    if (object.get("packages")) |value| {
        if (value == .string) {
            options.external_packages = std.ascii.eqlIgnoreCase(value.string, "external");
        }
    }
    if (object.get("conditions")) |value| {
        if (value == .array) {
            var conditions: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item == .string) try conditions.append(allocator, item.string);
            }
            options.conditions = conditions.items;
        }
    }
    if (object.get("minify")) |value| switch (value) {
        .bool => |enabled| {
            options.minify_whitespace = enabled;
            options.minify_identifiers = enabled;
            options.minify_syntax = enabled;
        },
        .object => |minify| {
            if (minify.get("whitespace")) |item| {
                if (item == .bool) options.minify_whitespace = item.bool;
            }
            if (minify.get("identifiers")) |item| {
                if (item == .bool) options.minify_identifiers = item.bool;
            }
            if (minify.get("syntax")) |item| {
                if (item == .bool) options.minify_syntax = item.bool;
            }
        },
        else => {},
    };
    if (object.get("reactFastRefresh")) |value| {
        if (value == .bool) options.react_fast_refresh = value.bool;
    }
    if (object.get("external")) |value| {
        if (value == .array) {
            var external: std.ArrayList([]const u8) = .empty;
            for (value.array.items) |item| {
                if (item == .string) try external.append(allocator, item.string);
            }
            options.external = external.items;
        }
    }
    if (object.get("define")) |value| {
        if (value == .object) {
            var keys: std.ArrayList([]const u8) = .empty;
            var values: std.ArrayList([]const u8) = .empty;
            var iterator = value.object.iterator();
            while (iterator.next()) |entry| {
                if (entry.value_ptr.* != .string) continue;
                try keys.append(allocator, entry.key_ptr.*);
                try values.append(allocator, entry.value_ptr.string);
            }
            options.define_keys = keys.items;
            options.define_values = values.items;
        }
    }
    if (object.get("naming")) |value| switch (value) {
        .string => |template| options.entry_naming = try namingTemplate(allocator, template),
        .object => |naming| {
            if (naming.get("entry")) |item| {
                if (item == .string) options.entry_naming = try namingTemplate(allocator, item.string);
            }
            if (naming.get("chunk")) |item| {
                if (item == .string) options.chunk_naming = try namingTemplate(allocator, item.string);
            }
            if (naming.get("asset")) |item| {
                if (item == .string) options.asset_naming = try namingTemplate(allocator, item.string);
            }
        },
        else => {},
    };
    return options;
}

/// Bun's JS API prefixes relative naming templates with "./" (see
/// JSBundler.Config: owned_entry_point building).
fn namingTemplate(allocator: std.mem.Allocator, template: []const u8) ![]const u8 {
    if (std.mem.startsWith(u8, template, "./") or std.mem.startsWith(u8, template, "/")) return template;
    return std.mem.concat(allocator, u8, &.{ "./", template });
}

const BuildLogPositionJson = struct {
    lineText: ?[]const u8 = null,
    file: []const u8,
    namespace: []const u8,
    line: i32,
    column: i32,
    length: u64,
    offset: u64,
};

const BuildLogJson = struct {
    name: []const u8,
    level: []const u8,
    message: []const u8,
    position: ?BuildLogPositionJson = null,
    specifier: ?[]const u8 = null,
    importKind: ?[]const u8 = null,
};

const BuildOutputJson = struct {
    path: []const u8,
    kind: []const u8,
    loader: []const u8,
    hash: ?[]const u8 = null,
    sourcemapIndex: ?u32 = null,
    b64: []const u8,
};

const BuildResultJson = struct {
    success: bool,
    logs: []const BuildLogJson,
    outputs: []const BuildOutputJson,
};

fn buildLogFromMessage(allocator: std.mem.Allocator, message: *const compiler.logger.Msg) !BuildLogJson {
    var entry = BuildLogJson{
        .name = if (message.metadata == .resolve) "ResolveMessage" else "BuildMessage",
        .level = message.kind.string(),
        .message = try allocator.dupe(u8, message.data.text),
    };
    if (message.data.location) |location| {
        entry.position = .{
            .lineText = if (location.line_text) |text|
                try allocator.dupe(u8, std.mem.trimEnd(u8, text, "\r\n"))
            else
                null,
            .file = try allocator.dupe(u8, location.file),
            .namespace = if (location.namespace.len > 0) try allocator.dupe(u8, location.namespace) else "file",
            .line = location.line,
            .column = location.column,
            .length = location.length,
            .offset = location.offset,
        };
    }
    if (message.metadata == .resolve) {
        entry.specifier = try allocator.dupe(u8, message.metadata.resolve.specifier.slice(message.data.text));
        entry.importKind = message.metadata.resolve.import_kind.label();
    }
    return entry;
}

fn buildLogsFromLogger(allocator: std.mem.Allocator, log: *const compiler.logger.Log, errors_only: bool) ![]const BuildLogJson {
    var logs: std.ArrayList(BuildLogJson) = .empty;
    for (log.msgs.items) |*message| {
        if (errors_only and message.kind != .err) continue;
        if (message.kind != .err and message.kind != .warn) continue;
        try logs.append(allocator, try buildLogFromMessage(allocator, message));
    }
    return logs.items;
}

fn buildFailureJson(allocator: std.mem.Allocator, log: *const compiler.logger.Log, fallback: anyerror) ![]u8 {
    var logs = try buildLogsFromLogger(allocator, log, false);
    if (logs.len == 0) {
        var fallback_logs = try allocator.alloc(BuildLogJson, 1);
        fallback_logs[0] = .{
            .name = "BuildMessage",
            .level = "error",
            .message = try std.fmt.allocPrint(allocator, "JavaScript bundle failed: {s}", .{@errorName(fallback)}),
        };
        logs = fallback_logs;
    }
    const result = BuildResultJson{ .success = false, .logs = logs, .outputs = &.{} };
    const json = try std.json.Stringify.valueAlloc(allocator, result, .{});
    return try c_allocator.dupe(u8, json);
}

/// Bun.build JS API entry point: bundles one or more entry points in-memory
/// and returns a JSON document with structured outputs (base64 contents,
/// relative paths, artifact kinds/loaders/hashes) and structured logs
/// (including source positions), mirroring Bun's BuildArtifact/BuildMessage
/// shapes. Never writes to disk; the JS driver materializes `outdir`.
pub fn buildEntryPointsJson(
    request_json: []const u8,
    working_dir: []const u8,
    error_out: *?[*:0]u8,
) ![]u8 {
    var arena = std.heap.ArenaAllocator.init(c_allocator);
    defer arena.deinit();
    const arena_allocator = arena.allocator();

    const parsed_request = std.json.parseFromSlice(std.json.Value, arena_allocator, request_json, .{}) catch {
        setError(error_out, "Invalid Bun.build options: expected a JSON object", .{});
        return error.InvalidOptions;
    };
    if (parsed_request.value != .object) {
        setError(error_out, "Invalid Bun.build options: expected a JSON object", .{});
        return error.InvalidOptions;
    }
    const request_object = parsed_request.value.object;
    var entry_points: std.ArrayList([]const u8) = .empty;
    if (request_object.get("entrypoints")) |value| {
        if (value == .array) {
            for (value.array.items) |item| {
                if (item == .string) try entry_points.append(arena_allocator, item.string);
            }
        }
    }
    if (entry_points.items.len == 0) {
        setError(error_out, "Bun.build requires at least one entry point", .{});
        return error.InvalidOptions;
    }
    var options = parseBuildOptions(request_json, arena_allocator) catch |err| {
        setError(error_out, "Invalid Bun.build options: {s}", .{@errorName(err)});
        return err;
    };
    // Bun.build defaults to target "browser" (the runtime bundler defaults to
    // "bun"); an explicit target was already applied by parseBuildOptions.
    if (request_object.get("target") == null) options.target = .browser;

    const allocator = compiler.default_allocator;
    compiler.cli.start_time = compiler.nanoTimestamp();
    const working_dir_z = try allocator.dupeZ(u8, working_dir);
    defer allocator.free(working_dir_z);

    var transform_options = std.mem.zeroes(compiler.schema.api.TransformOptions);
    transform_options.absolute_working_dir = working_dir_z;
    transform_options.entry_points = entry_points.items;
    transform_options.target = options.target;
    transform_options.write = false;
    transform_options.output_dir = "";
    transform_options.source_map = options.source_map;
    transform_options.conditions = options.conditions;
    transform_options.tsconfig_override = options.tsconfig_override;
    transform_options.packages = if (options.external_packages) .external else .bundle;
    transform_options.external = options.external;
    transform_options.disable_hmr = true;
    transform_options.main_fields = &.{ "main", "module" };
    if (options.define_keys.len > 0) {
        transform_options.define = .{
            .keys = options.define_keys,
            .values = options.define_values,
        };
    }

    var log = compiler.logger.Log.init(allocator);
    var transpiler = compiler.Transpiler.init(allocator, &log, transform_options, null) catch |err| {
        const json = buildFailureJson(arena_allocator, &log, err) catch {
            setBuildError(error_out, &log, err);
            log.deinit();
            return err;
        };
        log.deinit();
        return json;
    };
    defer transpiler.deinitPreservingFileSystem();
    try transpiler.fs.setTopLevelDir(working_dir_z);

    transpiler.options.output_format = options.output_format;
    transpiler.options.source_map = compiler.options.SourceMapOption.fromApi(options.source_map);
    transpiler.options.minify_whitespace = options.minify_whitespace;
    transpiler.options.minify_identifiers = options.minify_identifiers;
    transpiler.options.minify_syntax = options.minify_syntax;
    // Match Bun's root-dir default: the directory of a single entry point, or
    // the longest common path of multiple entry points, so `[dir]` in naming
    // templates resolves entry-relative rather than cwd-relative.
    if (request_object.get("root")) |value| {
        if (value == .string) transpiler.options.root_dir = value.string;
    }
    if (transpiler.options.root_dir.len == 0) {
        transpiler.options.root_dir = if (entry_points.items.len == 1)
            (std.fs.path.dirname(entry_points.items[0]) orelse ".")
        else
            compiler.path.getIfExistsLongestCommonPath(entry_points.items) orelse ".";
    }
    transpiler.options.react_fast_refresh = options.react_fast_refresh;
    transpiler.options.entry_naming = options.entry_naming;
    transpiler.options.chunk_naming = options.chunk_naming;
    transpiler.options.asset_naming = options.asset_naming;
    transpiler.options.supports_multiple_outputs = true;
    // Cottontail's vendored JSC has no native `using` / `await using`
    // support; always lower them so Bun.build outputs can run on this runtime.
    transpiler.options.force_lower_using = true;
    transpiler.configureDefines() catch |err| {
        return try buildFailureJson(arena_allocator, &log, err);
    };
    transpiler.configureLinker();
    transpiler.resolver.opts = transpiler.options;
    transpiler.resolver.env_loader = transpiler.env;

    var reachable_files_count: usize = 0;
    var minify_duration: u64 = 0;
    var source_code_size: u64 = 0;
    const event_loop = compiler.jsc.AnyEventLoop.init(allocator);
    const worker_pool = sharedWorkerPool();
    var bundle: ?*compiler.bundle_v2.BundleV2 = null;
    defer if (bundle) |value| {
        if (worker_pool != null) value.deinitFromCLI(allocator) else value.deinitWithoutFreeingArena();
    };
    // BundleV2.init points `log.msgs.allocator` at the bundle arena, so the
    // log must be abandoned (not freed) before the arena teardown above runs;
    // message texts consumed by callers are duped out beforehand.
    defer log.msgs = std.array_list.Managed(compiler.logger.Msg).init(allocator);
    var result = compiler.bundle_v2.BundleV2.generateFromCLIReleasable(
        &transpiler,
        allocator,
        event_loop,
        false,
        &reachable_files_count,
        &minify_duration,
        &source_code_size,
        null,
        null,
        &bundle,
        worker_pool,
    ) catch |err| {
        return try buildFailureJson(arena_allocator, &log, err);
    };
    defer result.deinit();

    var outputs: std.ArrayList(BuildOutputJson) = .empty;
    const base64 = std.base64.standard.Encoder;
    for (result.output_files.items) |output_file| {
        const bytes = output_file.value.asSlice();
        const encoded = try arena_allocator.alloc(u8, base64.calcSize(bytes.len));
        _ = base64.encode(encoded, bytes);
        const hash: ?[]const u8 = if (output_file.hash != 0)
            try std.fmt.allocPrint(arena_allocator, "{f}", .{compiler.fmt.truncatedHash32(output_file.hash)})
        else
            null;
        try outputs.append(arena_allocator, .{
            .path = try arena_allocator.dupe(u8, output_file.dest_path),
            .kind = @tagName(output_file.output_kind),
            .loader = @tagName(output_file.input_loader),
            .hash = hash,
            .sourcemapIndex = if (output_file.source_map_index != std.math.maxInt(u32))
                output_file.source_map_index
            else
                null,
            .b64 = encoded,
        });
    }

    const result_json = BuildResultJson{
        .success = true,
        .logs = try buildLogsFromLogger(arena_allocator, &log, false),
        .outputs = outputs.items,
    };
    const json = try std.json.Stringify.valueAlloc(arena_allocator, result_json, .{});
    return try c_allocator.dupe(u8, json);
}

pub export fn ct_bundle_entry_point_options(
    entry_ptr: ?[*]const u8,
    entry_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    options_ptr: ?[*]const u8,
    options_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const entry_path = if (entry_ptr) |ptr| ptr[0..entry_len] else {
        setError(error_out, "entry point is required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setError(error_out, "working directory is required", .{});
        return null;
    };
    const options_json = if (options_ptr) |ptr| ptr[0..options_len] else "";
    var arena = std.heap.ArenaAllocator.init(c_allocator);
    defer arena.deinit();
    const options = parseBuildOptions(options_json, arena.allocator()) catch |err| {
        setError(error_out, "Invalid Bun.build options: {s}", .{@errorName(err)});
        return null;
    };
    const output = bundleEntryPointWithOptions(entry_path, working_dir, options, error_out) catch return null;
    out_len.* = output.len;
    return output.ptr;
}

pub export fn ct_bundle_build(
    request_ptr: ?[*]const u8,
    request_len: usize,
    working_dir_ptr: ?[*]const u8,
    working_dir_len: usize,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;
    const request_json = if (request_ptr) |ptr| ptr[0..request_len] else {
        setError(error_out, "Bun.build options are required", .{});
        return null;
    };
    const working_dir = if (working_dir_ptr) |ptr| ptr[0..working_dir_len] else {
        setError(error_out, "working directory is required", .{});
        return null;
    };
    const output = buildEntryPointsJson(request_json, working_dir, error_out) catch |err| {
        if (error_out.* == null) setError(error_out, "JavaScript bundle failed: {s}", .{@errorName(err)});
        return null;
    };
    out_len.* = output.len;
    return output.ptr;
}

pub export fn ct_bundle_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

pub export fn ct_bundle_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_bundle_entry_point;
    _ = &ct_bundle_entry_point_options;
    _ = &ct_bundle_build;
    _ = &ct_bundle_free;
    _ = &ct_bundle_string_free;
}
