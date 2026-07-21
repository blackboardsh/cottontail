const std = @import("std");
const compiler = @import("cottontail_compiler");
const bundler = @import("cottontail_bundler.zig");

pub fn scan(
    allocator: std.mem.Allocator,
    io: std.Io,
    entry_points: []const []const u8,
    working_dir: []const u8,
    stderr: *std.Io.Writer,
) ![]const []const u8 {
    var dependencies: std.ArrayList([]const u8) = .empty;
    var seen = std.StringHashMap(void).init(allocator);

    for (entry_points) |entry_point| {
        const absolute_entry = if (std.fs.path.isAbsolute(entry_point))
            try std.fs.path.resolve(allocator, &.{entry_point})
        else
            try std.fs.path.resolve(allocator, &.{ working_dir, entry_point });

        var error_message: ?[*:0]u8 = null;
        const bundled = bundler.bundleEntryPointWithOptions(
            absolute_entry,
            working_dir,
            .{
                .external_packages = true,
                .output_format = .esm,
                .target = .bun,
                .no_macros = true,
            },
            &error_message,
        ) catch |err| {
            defer if (error_message) |message| bundler.ct_bundle_string_free(message);
            if (error_message) |message| {
                try stderr.print("error: {s}\n", .{std.mem.span(message)});
                return error.PackageManagerErrorReported;
            }
            return err;
        };
        defer bundler.ct_bundle_free(bundled.ptr, bundled.len);
        defer if (error_message) |message| bundler.ct_bundle_string_free(message);

        var log = compiler.logger.Log.init(allocator);
        const source = compiler.logger.Source.initPathString(absolute_entry, bundled);
        const define = try compiler.Define.init(allocator, null, null, false, false);
        var options = compiler.js_parser.Parser.Options.init(.{}, .js);
        var macro_context = compiler.ast.Macro.MacroContext.initStandalone();
        options.macro_context = &macro_context;
        options.bundle = false;
        var parser = try compiler.js_parser.Parser.init(options, &log, &source, define, allocator);
        var scan_pass = compiler.js_parser.ScanPassResult.init(allocator);
        try parser.scanImports(&scan_pass);
        if (log.errors > 0) {
            log.print(stderr) catch {};
            return error.PackageManagerErrorReported;
        }

        for (scan_pass.import_records.items) |record| {
            if (record.flags.is_unused) continue;
            const package_name = packageName(record.path.text) orelse continue;
            if (seen.contains(package_name)) continue;
            try seen.put(try allocator.dupe(u8, package_name), {});
            try dependencies.append(allocator, try allocator.dupe(u8, package_name));
        }
    }

    _ = io;
    return dependencies.toOwnedSlice(allocator);
}

fn packageName(specifier: []const u8) ?[]const u8 {
    if (specifier.len == 0 or
        specifier[0] == '.' or
        specifier[0] == '/' or
        specifier[0] == '#' or
        std.mem.indexOfScalar(u8, specifier, '\\') != null or
        std.mem.startsWith(u8, specifier, "node:") or
        std.mem.startsWith(u8, specifier, "bun:") or
        std.mem.startsWith(u8, specifier, "data:") or
        std.mem.startsWith(u8, specifier, "file:") or
        std.mem.startsWith(u8, specifier, "http:") or
        std.mem.startsWith(u8, specifier, "https:"))
    {
        return null;
    }
    if (compiler.jsc.ModuleLoader.HardcodedModule.map.get(specifier) != null) return null;

    if (specifier[0] == '@') {
        const scope_end = std.mem.indexOfScalar(u8, specifier, '/') orelse return null;
        const package_end = std.mem.indexOfScalarPos(u8, specifier, scope_end + 1, '/') orelse specifier.len;
        if (scope_end + 1 == package_end) return null;
        return specifier[0..package_end];
    }
    const package_end = std.mem.indexOfScalar(u8, specifier, '/') orelse specifier.len;
    const name = specifier[0..package_end];
    if (std.mem.indexOfScalar(u8, name, ':') != null) return null;
    return if (name.len > 0) name else null;
}

test "extract package names from external import records" {
    try std.testing.expectEqualStrings("react", packageName("react/jsx-runtime").?);
    try std.testing.expectEqualStrings("@scope/pkg", packageName("@scope/pkg/subpath").?);
    try std.testing.expect(packageName("./local.ts") == null);
    try std.testing.expect(packageName("node:fs") == null);
}
