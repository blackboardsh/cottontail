const std = @import("std");
const source_create = @import("cli_create_source.zig");

const max_entry_path_bytes = 1024 * 1024;

pub fn run(
    init: std.process.Init,
    args: []const [:0]const u8,
    stdout: *std.Io.Writer,
    stderr: *std.Io.Writer,
) !u8 {
    if (args.len < 2) {
        try stderr.writeAll("cottontail: create-source service requires an operation and input path\n");
        return 1;
    }

    const operation: []const u8 = args[0];
    if (!std.mem.eql(u8, operation, "analyze")) {
        try stderr.print("cottontail: unknown create-source service operation: {s}\n", .{operation});
        return 1;
    }

    const allocator = init.arena.allocator();
    const entry_absolute = try std.Io.Dir.cwd().readFileAlloc(
        init.io,
        args[1],
        allocator,
        .limited(max_entry_path_bytes),
    );
    if (entry_absolute.len == 0 or std.mem.indexOfScalar(u8, entry_absolute, 0) != null) {
        try stderr.writeAll("cottontail: create-source analysis requires a valid entry path\n");
        return 1;
    }

    const analysis = try source_create.analyze(init, entry_absolute, stderr);
    try writeAnalysis(analysis, stdout);
    return 0;
}

fn writeAnalysis(
    analysis: source_create.Analysis,
    writer: *std.Io.Writer,
) !void {
    try std.json.Stringify.value(.{
        .dependencies = analysis.dependencies.items,
        .shadcn_components = analysis.shadcn_components.items,
        .component_export = analysis.component_export,
        .uses_tailwind = analysis.uses_tailwind,
    }, .{}, writer);
}

test "create-source service serializes its narrow analysis response" {
    var analysis: source_create.Analysis = .{
        .component_export = "App",
        .uses_tailwind = true,
    };
    defer analysis.dependencies.deinit(std.testing.allocator);
    defer analysis.shadcn_components.deinit(std.testing.allocator);
    try analysis.dependencies.append(std.testing.allocator, "zod");
    try analysis.shadcn_components.append(std.testing.allocator, "button");

    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try writeAnalysis(analysis, &output.writer);

    const parsed = try std.json.parseFromSlice(
        std.json.Value,
        std.testing.allocator,
        output.written(),
        .{},
    );
    defer parsed.deinit();
    try std.testing.expectEqualStrings(
        "zod",
        parsed.value.object.get("dependencies").?.array.items[0].string,
    );
    try std.testing.expectEqualStrings(
        "App",
        parsed.value.object.get("component_export").?.string,
    );
}
