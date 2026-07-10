const std = @import("std");
const bun = @import("bun");

const c_allocator = std.heap.c_allocator;
const bun_allocator = bun.default_allocator;

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

fn stripTypeScriptTypes(source_code: []const u8, mode: c_int) ![]u8 {
    _ = mode;

    bun.ast.Expr.Data.Store.create();
    bun.ast.Stmt.Data.Store.create();
    defer bun.ast.Expr.Data.Store.reset();
    defer bun.ast.Stmt.Data.Store.reset();

    var log = bun.logger.Log.init(bun_allocator);
    defer log.deinit();

    const source = bun.logger.Source.initPathString("input.ts", source_code);
    var define = try bun.Define.init(bun_allocator, null, null, false, false);
    defer define.deinit();

    var opts = bun.js_parser.Parser.Options.init(.{}, .ts);
    opts.transform_only = true;

    var parser = try bun.js_parser.Parser.init(opts, &log, &source, define, bun_allocator);
    const result = try parser.parse();
    var ast = result.ast;
    defer ast.deinit();

    const symbol_list = bun.ast.Symbol.List.fromBorrowedSliceDangerous(ast.symbols.slice());
    const nested_symbols = bun.ast.Symbol.NestedList.fromBorrowedSliceDangerous(&.{symbol_list});
    var no_op_renamer = bun.renamer.NoOpRenamer.init(bun.ast.Symbol.Map.initList(nested_symbols), &source);

    const print_result = bun.js_printer.print(
        bun_allocator,
        .node,
        ast,
        &source,
        .{
            .allocator = bun_allocator,
            .target = .node,
            .transform_only = true,
            .mangled_props = null,
        },
        ast.import_records.slice(),
        ast.parts.slice(),
        no_op_renamer.toRenamer(),
        false,
    );

    const printed = switch (print_result) {
        .result => |success| success.code,
        .err => |err| return err,
    };
    defer bun_allocator.free(printed);

    return try c_allocator.dupe(u8, printed);
}

export fn ct_strip_typescript_types(
    source_ptr: ?[*]const u8,
    source_len: usize,
    mode: c_int,
    out_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    out_len.* = 0;
    error_out.* = null;

    const source = if (source_ptr) |ptr| ptr[0..source_len] else blk: {
        if (source_len == 0) break :blk "";
        setError(error_out, "source pointer is null", .{});
        return null;
    };

    const output = stripTypeScriptTypes(source, mode) catch |err| {
        setError(error_out, "TypeScript transform failed: {s}", .{@errorName(err)});
        return null;
    };

    out_len.* = output.len;
    return output.ptr;
}

export fn ct_transpiler_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

export fn ct_transpiler_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_strip_typescript_types;
    _ = &ct_transpiler_free;
    _ = &ct_transpiler_string_free;
}
