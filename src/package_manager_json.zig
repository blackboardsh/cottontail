const std = @import("std");
const compiler = @import("cottontail_compiler");

const Value = std.json.Value;

pub fn parsePackageJSON(
    allocator: std.mem.Allocator,
    path: []const u8,
    contents: []const u8,
) !Value {
    return parsePackageJSONImpl(allocator, path, contents, null, false);
}

pub fn parseInstallPackageJSON(
    allocator: std.mem.Allocator,
    path: []const u8,
    contents: []const u8,
    stderr: *std.Io.Writer,
) !Value {
    return parsePackageJSONImpl(allocator, path, contents, stderr, true);
}

pub fn printDuplicateWorkspaceName(
    allocator: std.mem.Allocator,
    name: []const u8,
    duplicate_path: []const u8,
    duplicate_contents: []const u8,
    first_path: []const u8,
    first_contents: []const u8,
    stderr: *std.Io.Writer,
) !bool {
    compiler.install.initializeStore();
    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();

    const duplicate_source = compiler.logger.Source.initPathString(duplicate_path, duplicate_contents);
    const duplicate_expression = compiler.json.parsePackageJSONUTF8(&duplicate_source, &log, allocator) catch return false;
    const duplicate_name = duplicate_expression.asProperty("name") orelse return false;

    const first_source = compiler.logger.Source.initPathString(first_path, first_contents);
    const first_expression = compiler.json.parsePackageJSONUTF8(&first_source, &log, allocator) catch return false;
    const first_name = first_expression.asProperty("name") orelse return false;

    const notes = try allocator.alloc(compiler.logger.Data, 1);
    notes[0] = .{
        .text = "Package name is also declared here",
        .location = compiler.logger.Location.initOrNull(
            &first_source,
            first_source.rangeOfString(first_name.loc),
        ),
    };
    try log.addRangeErrorFmtWithNotes(
        &duplicate_source,
        duplicate_source.rangeOfString(duplicate_name.loc),
        allocator,
        notes,
        "Workspace name \"{s}\" already exists",
        .{name},
    );
    try log.print(stderr);
    return true;
}

fn parsePackageJSONImpl(
    allocator: std.mem.Allocator,
    path: []const u8,
    contents: []const u8,
    stderr: ?*std.Io.Writer,
    validate_install_shape: bool,
) !Value {
    compiler.install.initializeStore();
    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();

    const source = compiler.logger.Source.initPathString(path, contents);
    const expression = compiler.json.parsePackageJSONUTF8(&source, &log, allocator) catch {
        if (stderr) |writer| {
            try log.print(writer);
            try writer.print("ParserError: failed to parse '{s}'\n", .{path});
            return error.PackageManagerErrorReported;
        }
        return error.InvalidPackageJSON;
    };
    if (log.errors > 0) {
        if (stderr) |writer| {
            try log.print(writer);
            return error.PackageManagerErrorReported;
        }
        return error.InvalidPackageJSON;
    }

    if (validate_install_shape) {
        inline for ([_][]const u8{
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
        }) |section_name| {
            if (expression.asProperty(section_name)) |dependencies| {
                if (dependencies.expr.data != .e_object) {
                    try log.addErrorFmt(&source, dependencies.loc, allocator,
                        \\{0s} expects a map of specifiers, e.g.
                        \\  <r><green>"{0s}"<r>: {{
                        \\    <green>"bun"<r>: <green>"latest"<r>
                        \\  }}
                    , .{section_name});
                } else {
                    for (dependencies.expr.data.e_object.properties.slice()) |property| {
                        if (property.value.?.asString(allocator) != null) continue;
                        try log.addErrorFmt(&source, property.value.?.loc, allocator,
                            \\{0s} expects a map of specifiers, e.g.
                            \\  <r><green>"{0s}"<r>: {{
                            \\    <green>"bun"<r>: <green>"latest"<r>
                            \\  }}
                        , .{section_name});
                        break;
                    }
                }
                if (log.hasErrors()) break;
            }
        }

        if (!log.hasErrors()) if (expression.asProperty("workspaces")) |workspaces| {
            switch (workspaces.expr.data) {
                .e_array => {},
                .e_object => |object| if (object.get("packages")) |packages| {
                    if (packages.data != .e_array) {
                        try log.addErrorFmt(&source, packages.loc, allocator,
                            \\"workspaces.packages" expects an array of strings, e.g.
                            \\  "workspaces": {{
                            \\    "packages": [
                            \\      "path/to/package"
                            \\    ]
                            \\  }}
                        , .{});
                    }
                },
                else => try log.addErrorFmt(&source, workspaces.loc, allocator,
                    \\"workspaces" expects an array of strings, e.g.
                    \\  <r><green>"workspaces"<r>: [
                    \\    <green>"path/to/package"<r>
                    \\  ]
                , .{}),
            }
        };

        if (log.hasErrors()) {
            const writer = stderr.?;
            try log.print(writer);
            return error.PackageManagerErrorReported;
        }
    }

    const buffer_writer = compiler.js_printer.BufferWriter.init(allocator);
    var printer = compiler.js_printer.BufferPrinter.init(buffer_writer);
    _ = compiler.js_printer.printJSON(
        @TypeOf(&printer),
        &printer,
        expression,
        &source,
        .{ .minify_whitespace = true, .mangled_props = null },
    ) catch return error.InvalidPackageJSON;

    return std.json.parseFromSliceLeaky(
        Value,
        allocator,
        printer.ctx.writtenWithoutTrailingZero(),
        .{},
    ) catch return error.InvalidPackageJSON;
}
