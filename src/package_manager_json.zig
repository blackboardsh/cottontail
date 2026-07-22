const std = @import("std");
const compiler = @import("cottontail_compiler");

const Value = std.json.Value;

pub fn parsePackageJSON(
    allocator: std.mem.Allocator,
    path: []const u8,
    contents: []const u8,
) !Value {
    compiler.install.initializeStore();
    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();

    const source = compiler.logger.Source.initPathString(path, contents);
    const expression = compiler.json.parsePackageJSONUTF8(&source, &log, allocator) catch
        return error.InvalidPackageJSON;
    if (log.errors > 0) return error.InvalidPackageJSON;

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
