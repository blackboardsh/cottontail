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
};

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

    var loader_extensions: [1][]const u8 = undefined;
    var loader_values: [1]compiler.schema.api.Loader = undefined;
    if (options.loader) |loader_name| {
        const loader = compiler.options.Loader.fromString(loader_name) orelse {
            setError(error_out, "Unsupported loader: {s}", .{loader_name});
            return error.InvalidLoader;
        };
        const extension = std.fs.path.extension(entry_path);
        loader_extensions[0] = if (extension.len > 0) extension else ".js";
        loader_values[0] = @enumFromInt(@intFromEnum(loader));
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
    var result = compiler.bundle_v2.BundleV2.generateFromCLI(
        &transpiler,
        allocator,
        event_loop,
        false,
        &reachable_files_count,
        &minify_duration,
        &source_code_size,
        null,
        runtime_file_map_ptr,
    ) catch |err| {
        setBuildError(error_out, &log, err);
        return err;
    };
    defer result.deinit();

    for (result.output_files.items) |output_file| {
        if (output_file.output_kind != .@"entry-point" and output_file.output_kind != .chunk) continue;
        const bytes = output_file.value.asSlice();
        if (bytes.len > 0) return try c_allocator.dupe(u8, bytes);
    }

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
    return options;
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

pub export fn ct_bundle_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

pub export fn ct_bundle_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_bundle_entry_point;
    _ = &ct_bundle_entry_point_options;
    _ = &ct_bundle_free;
    _ = &ct_bundle_string_free;
}
