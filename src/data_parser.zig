const std = @import("std");
const compiler = @import("cottontail_compiler");

const Expr = compiler.ast.Expr;

const ErrorKind = enum(c_int) {
    syntax = 1,
    range = 2,
    generic = 3,
};

extern fn ct_data_parser_builder_make_null(builder: *anyopaque) usize;
extern fn ct_data_parser_builder_make_undefined(builder: *anyopaque) usize;
extern fn ct_data_parser_builder_make_boolean(builder: *anyopaque, value: bool) usize;
extern fn ct_data_parser_builder_make_number(builder: *anyopaque, value: f64) usize;
extern fn ct_data_parser_builder_make_string(builder: *anyopaque, value: [*]const u8, len: usize) usize;
extern fn ct_data_parser_builder_make_array(builder: *anyopaque, len: usize) usize;
extern fn ct_data_parser_builder_make_object(builder: *anyopaque) usize;
extern fn ct_data_parser_builder_set_index(builder: *anyopaque, array: usize, index: usize, value: usize) bool;
extern fn ct_data_parser_builder_set_property(builder: *anyopaque, object: usize, key: usize, value: usize) bool;
extern fn ct_data_parser_builder_set_error(
    builder: *anyopaque,
    kind: c_int,
    message: [*]const u8,
    len: usize,
) void;

const Materializer = struct {
    allocator: std.mem.Allocator,
    builder: *anyopaque,
    seen: std.AutoHashMapUnmanaged(usize, usize) = .empty,

    fn deinit(self: *Materializer) void {
        self.seen.deinit(self.allocator);
    }

    fn fail(self: *Materializer, message: []const u8) error{MaterializeFailed} {
        ct_data_parser_builder_set_error(
            self.builder,
            @intFromEnum(ErrorKind.generic),
            message.ptr,
            message.len,
        );
        return error.MaterializeFailed;
    }

    fn requireHandle(self: *Materializer, handle: usize) error{MaterializeFailed}!usize {
        if (handle == 0) return self.fail("Unable to construct parsed JavaScript value");
        return handle;
    }

    fn toJS(self: *Materializer, expr: Expr, depth: usize) !usize {
        if (depth > 4_096) {
            ct_data_parser_builder_set_error(
                self.builder,
                @intFromEnum(ErrorKind.range),
                "Maximum parser result nesting depth exceeded",
                "Maximum parser result nesting depth exceeded".len,
            );
            return error.MaterializeFailed;
        }

        return switch (expr.data) {
            .e_null => self.requireHandle(ct_data_parser_builder_make_null(self.builder)),
            .e_undefined => self.requireHandle(ct_data_parser_builder_make_undefined(self.builder)),
            .e_boolean, .e_branch_boolean => |boolean| self.requireHandle(
                ct_data_parser_builder_make_boolean(self.builder, boolean.value),
            ),
            .e_number => |number| self.requireHandle(
                ct_data_parser_builder_make_number(self.builder, number.value),
            ),
            .e_string => |string| string_value: {
                const bytes = try string.string(self.allocator);
                break :string_value self.requireHandle(
                    ct_data_parser_builder_make_string(self.builder, bytes.ptr, bytes.len),
                );
            },
            .e_array => |array| collection: {
                const identity = @intFromPtr(array);
                if (self.seen.get(identity)) |existing| break :collection existing;

                const handle = try self.requireHandle(
                    ct_data_parser_builder_make_array(self.builder, array.items.len),
                );
                try self.seen.put(self.allocator, identity, handle);
                for (array.slice(), 0..) |item, index| {
                    const value = try self.toJS(item, depth + 1);
                    if (!ct_data_parser_builder_set_index(self.builder, handle, index, value)) {
                        return self.fail("Unable to populate parsed JavaScript array");
                    }
                }
                break :collection handle;
            },
            .e_object => |object| collection: {
                const identity = @intFromPtr(object);
                if (self.seen.get(identity)) |existing| break :collection existing;

                const handle = try self.requireHandle(ct_data_parser_builder_make_object(self.builder));
                try self.seen.put(self.allocator, identity, handle);
                for (object.properties.slice()) |property| {
                    if (property.key == null or property.value == null) {
                        return self.fail("Parsed object contained an unsupported property");
                    }
                    const key = try self.toJS(property.key.?, depth + 1);
                    const value = try self.toJS(property.value.?, depth + 1);
                    if (!ct_data_parser_builder_set_property(self.builder, handle, key, value)) {
                        return self.fail("Unable to populate parsed JavaScript object");
                    }
                }
                break :collection handle;
            },
            .e_inlined_enum => |inlined| self.toJS(inlined.value, depth + 1),
            else => self.fail("Parsed document contained an unsupported value"),
        };
    }
};

fn reportParseError(
    allocator: std.mem.Allocator,
    builder: *anyopaque,
    err: anyerror,
    log: *const compiler.logger.Log,
) void {
    if (err == error.StackOverflow) {
        const message = "Maximum YAML nesting depth exceeded";
        ct_data_parser_builder_set_error(
            builder,
            @intFromEnum(ErrorKind.range),
            message.ptr,
            message.len,
        );
        return;
    }

    if (err == error.OutOfMemory) {
        ct_data_parser_builder_set_error(
            builder,
            @intFromEnum(ErrorKind.generic),
            "Out of memory",
            "Out of memory".len,
        );
        return;
    }

    const detail = if (log.msgs.items.len > 0)
        log.msgs.items[0].data.text
    else
        "Unable to parse input";
    const message = std.fmt.allocPrint(
        allocator,
        "YAML Parse error: {s}",
        .{detail},
    ) catch detail;
    ct_data_parser_builder_set_error(
        builder,
        @intFromEnum(ErrorKind.syntax),
        message.ptr,
        message.len,
    );
}

pub export fn ct_yaml_parser_parse(
    input_pointer: ?[*]const u8,
    input_len: usize,
    builder: ?*anyopaque,
) usize {
    const output_builder = builder orelse return 0;
    if (input_len > 0 and input_pointer == null) return 0;
    const input = if (input_len == 0) "" else input_pointer.?[0..input_len];

    var arena = std.heap.ArenaAllocator.init(std.heap.c_allocator);
    defer arena.deinit();
    const allocator = arena.allocator();

    var ast_memory_allocator: compiler.ast.ASTMemoryAllocator = undefined;
    var ast_scope = ast_memory_allocator.enter(allocator);
    defer ast_scope.exit();

    var log = compiler.logger.Log.init(allocator);
    defer log.deinit();
    const source = compiler.logger.Source.initPathString("input.yaml", input);
    const root = compiler.interchange.yaml.YAML.parse(&source, &log, allocator) catch |err| {
        reportParseError(allocator, output_builder, err, &log);
        return 0;
    };

    var materializer: Materializer = .{
        .allocator = allocator,
        .builder = output_builder,
    };
    defer materializer.deinit();
    return materializer.toJS(root, 0) catch 0;
}
