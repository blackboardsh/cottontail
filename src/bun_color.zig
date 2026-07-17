const std = @import("std");
const compiler = @import("cottontail_compiler");

const css = compiler.css;
const color_types = css.css_values.color;
const CssColor = css.CssColor;
const JsonValue = std.json.Value;

const OutputFormat = enum {
    css,
    hex,
    HEX,
    hsl,
    lab,
    number,
    rgb,
    rgba,
    array_rgb,
    array_rgba,
    object_rgb,
    object_rgba,

    fn parse(value: []const u8) ?OutputFormat {
        const formats = std.StaticStringMap(OutputFormat).initComptime(.{
            .{ "css", .css },
            .{ "hex", .hex },
            .{ "HEX", .HEX },
            .{ "hsl", .hsl },
            .{ "lab", .lab },
            .{ "number", .number },
            .{ "rgb", .rgb },
            .{ "rgba", .rgba },
            .{ "[rgb]", .array_rgb },
            .{ "[rgba]", .array_rgba },
            .{ "{rgb}", .object_rgb },
            .{ "{rgba}", .object_rgba },
        });
        return formats.get(value);
    }
};

const Response = struct {
    success: bool,
    result: ?JsonValue = null,
    @"error": ?[]const u8 = null,
    code: ?[]const u8 = null,
    name: ?[]const u8 = null,
};

const ParseOutcome = union(enum) {
    parsed: CssColor.ParseResult,
    response: []u8,
};

fn responseJson(allocator: std.mem.Allocator, response: Response) ![]u8 {
    return std.json.Stringify.valueAlloc(allocator, response, .{});
}

fn invalidColorComponent(
    allocator: std.mem.Allocator,
    component: []const u8,
) ![]u8 {
    const message = try std.fmt.allocPrint(
        allocator,
        "Expected {s} to be a integer for 'color'.",
        .{component},
    );
    return responseJson(allocator, .{
        .success = false,
        .@"error" = message,
        .code = "ERR_INVALID_ARG_TYPE",
        .name = "TypeError",
    });
}

fn colorComponent(value: ?JsonValue) ?u8 {
    const number: i64 = switch (value orelse return null) {
        .integer => |integer| integer,
        .float => |float| if (std.math.isFinite(float)) @intFromFloat(float) else return null,
        else => return null,
    };
    return @intCast(std.math.clamp(number, 0, 255));
}

fn alphaComponent(value: ?JsonValue) u8 {
    const float: f64 = switch (value orelse return 255) {
        .integer => |integer| @floatFromInt(integer),
        .float => |number| if (std.math.isFinite(number)) number else return 255,
        else => return 255,
    };
    const scaled = compiler.intFromFloat(i64, float * 255.0);
    return @intCast(@mod(scaled, 256));
}

fn rgbaParseResult(red: u8, green: u8, blue: u8, alpha: u8) CssColor.ParseResult {
    return .{ .result = CssColor{ .rgba = .{
        .red = red,
        .green = green,
        .blue = blue,
        .alpha = alpha,
    } } };
}

fn arrayColor(
    allocator: std.mem.Allocator,
    array: std.json.Array,
) !ParseOutcome {
    if (array.items.len != 3 and array.items.len != 4) {
        return .{ .response = try responseJson(allocator, .{
            .success = false,
            .@"error" = "Expected array length 3 or 4",
            .name = "Error",
        }) };
    }

    const red = colorComponent(array.items[0]) orelse
        return .{ .response = try invalidColorComponent(allocator, "[0]") };
    const green = colorComponent(array.items[1]) orelse
        return .{ .response = try invalidColorComponent(allocator, "[1]") };
    const blue = colorComponent(array.items[2]) orelse
        return .{ .response = try invalidColorComponent(allocator, "[2]") };
    const alpha = if (array.items.len == 4)
        colorComponent(array.items[3]) orelse
            return .{ .response = try invalidColorComponent(allocator, "[3]") }
    else
        255;
    return .{ .parsed = rgbaParseResult(red, green, blue, alpha) };
}

fn objectColor(
    allocator: std.mem.Allocator,
    object: std.json.ObjectMap,
) !ParseOutcome {
    const red = colorComponent(object.get("r")) orelse
        return .{ .response = try invalidColorComponent(allocator, "r") };
    const green = colorComponent(object.get("g")) orelse
        return .{ .response = try invalidColorComponent(allocator, "g") };
    const blue = colorComponent(object.get("b")) orelse
        return .{ .response = try invalidColorComponent(allocator, "b") };
    return .{ .parsed = rgbaParseResult(red, green, blue, alphaComponent(object.get("a"))) };
}

fn packedNumberColor(value: JsonValue) ?CssColor.ParseResult {
    if (value != .array or value.array.items.len != 4) return null;
    const red = colorComponent(value.array.items[0]) orelse return null;
    const green = colorComponent(value.array.items[1]) orelse return null;
    const blue = colorComponent(value.array.items[2]) orelse return null;
    const alpha = colorComponent(value.array.items[3]) orelse return null;
    return rgbaParseResult(red, green, blue, alpha);
}

fn parseColorInput(
    allocator: std.mem.Allocator,
    request: std.json.ObjectMap,
) !ParseOutcome {
    const input = request.get("input") orelse return .{
        .response = try responseJson(allocator, .{
            .success = false,
            .@"error" = "The color input is required",
            .code = "ERR_INVALID_ARG_TYPE",
            .name = "TypeError",
        }),
    };

    if (request.get("inputKind")) |kind| {
        if (kind == .string and std.mem.eql(u8, kind.string, "packed-number")) {
            const parsed = packedNumberColor(input) orelse return .{
                .response = try responseJson(allocator, .{
                    .success = false,
                    .@"error" = "Invalid packed color number",
                    .code = "ERR_INVALID_ARG_VALUE",
                    .name = "TypeError",
                }),
            };
            return .{ .parsed = parsed };
        }
    }

    switch (input) {
        .array => |array| return arrayColor(allocator, array),
        .object => |object| return objectColor(allocator, object),
        .string => |source| {
            var parser_input = css.ParserInput.new(allocator, source);
            var parser = css.Parser.new(&parser_input, null, .{}, null);
            return .{ .parsed = CssColor.parse(&parser) };
        },
        else => return .{ .response = try responseJson(allocator, .{
            .success = true,
            .result = null,
        }) },
    }
}

fn toSrgb(color: *CssColor) ?color_types.SRGB {
    return switch (color.*) {
        .float => |float| switch (float.*) {
            .rgb => |rgb| rgb,
            inline else => |*value| value.into(.SRGB),
        },
        .rgba => |*rgba| rgba.into(.SRGB),
        .lab => |lab| switch (lab.*) {
            inline else => |value| value.into(.SRGB),
        },
        else => null,
    };
}

fn toHsl(color: *CssColor) ?color_types.HSL {
    return switch (color.*) {
        .float => |float| switch (float.*) {
            .hsl => |hsl| hsl,
            inline else => |*value| value.into(.HSL),
        },
        .rgba => |*rgba| rgba.into(.HSL),
        .lab => |lab| switch (lab.*) {
            inline else => |value| value.into(.HSL),
        },
        else => null,
    };
}

fn toLab(color: *CssColor) ?color_types.LAB {
    return switch (color.*) {
        .float => |float| switch (float.*) {
            inline else => |*value| value.into(.LAB),
        },
        .lab => |lab| switch (lab.*) {
            .lab => |value| value,
            inline else => |value| value.into(.LAB),
        },
        .rgba => |*rgba| rgba.into(.LAB),
        else => null,
    };
}

fn cssString(allocator: std.mem.Allocator, color: *CssColor) ![]const u8 {
    var destination = std.Io.Writer.Allocating.init(allocator);
    defer destination.deinit();
    const symbols = compiler.ast.Symbol.Map{};
    var printer = css.Printer.new(
        allocator,
        std.array_list.Managed(u8).init(allocator),
        &destination.writer,
        css.PrinterOptions.default(),
        null,
        null,
        &symbols,
    );
    defer printer.deinit();
    try color.toCss(&printer);
    return allocator.dupe(u8, destination.written());
}

fn rgbObject(allocator: std.mem.Allocator, rgba: color_types.RGBA, include_alpha: bool) !JsonValue {
    var object: std.json.ObjectMap = .empty;
    try object.put(allocator, "r", .{ .integer = rgba.red });
    try object.put(allocator, "g", .{ .integer = rgba.green });
    try object.put(allocator, "b", .{ .integer = rgba.blue });
    if (include_alpha) {
        try object.put(allocator, "a", .{ .float = @floatCast(rgba.alphaF32()) });
    }
    return .{ .object = object };
}

fn rgbArray(allocator: std.mem.Allocator, rgba: color_types.RGBA, include_alpha: bool) !JsonValue {
    var array = std.json.Array.init(allocator);
    try array.append(.{ .integer = rgba.red });
    try array.append(.{ .integer = rgba.green });
    try array.append(.{ .integer = rgba.blue });
    if (include_alpha) try array.append(.{ .integer = rgba.alpha });
    return .{ .array = array };
}

fn formattedColor(
    allocator: std.mem.Allocator,
    color: *CssColor,
    format: OutputFormat,
) !JsonValue {
    switch (format) {
        .css => return .{ .string = try cssString(allocator, color) },
        .hsl => if (toHsl(color)) |hsl| return .{
            .string = try std.fmt.allocPrint(allocator, "hsl({d}, {d}, {d})", .{ hsl.h, hsl.s, hsl.l }),
        },
        .lab => if (toLab(color)) |lab| return .{
            .string = try std.fmt.allocPrint(allocator, "lab({d}, {d}, {d})", .{ lab.l, lab.a, lab.b }),
        },
        else => {},
    }

    const srgb = toSrgb(color) orelse return .{ .string = try cssString(allocator, color) };
    const rgba = srgb.into(.RGBA);
    return switch (format) {
        .css, .hsl, .lab => unreachable,
        .number => .{ .integer = (@as(i64, rgba.red) << 16) |
            (@as(i64, rgba.green) << 8) |
            @as(i64, rgba.blue) },
        .hex => .{ .string = try std.fmt.allocPrint(
            allocator,
            "#{x:0>2}{x:0>2}{x:0>2}",
            .{ rgba.red, rgba.green, rgba.blue },
        ) },
        .HEX => .{ .string = try std.fmt.allocPrint(
            allocator,
            "#{X:0>2}{X:0>2}{X:0>2}",
            .{ rgba.red, rgba.green, rgba.blue },
        ) },
        .rgb => .{ .string = try std.fmt.allocPrint(
            allocator,
            "rgb({d}, {d}, {d})",
            .{ rgba.red, rgba.green, rgba.blue },
        ) },
        .rgba => .{ .string = try std.fmt.allocPrint(
            allocator,
            "rgba({d}, {d}, {d}, {d})",
            .{ rgba.red, rgba.green, rgba.blue, rgba.alphaF32() },
        ) },
        .array_rgb => try rgbArray(allocator, rgba, false),
        .array_rgba => try rgbArray(allocator, rgba, true),
        .object_rgb => try rgbObject(allocator, rgba, false),
        .object_rgba => try rgbObject(allocator, rgba, true),
    };
}

pub fn runRequest(allocator: std.mem.Allocator, value: JsonValue) ![]u8 {
    if (value != .object) return responseJson(allocator, .{
        .success = false,
        .@"error" = "Invalid Bun.color request",
        .code = "ERR_INVALID_ARG_VALUE",
        .name = "TypeError",
    });
    const format_value = value.object.get("format") orelse return responseJson(allocator, .{
        .success = false,
        .@"error" = "Bun.color format is required",
        .code = "ERR_INVALID_ARG_VALUE",
        .name = "TypeError",
    });
    if (format_value != .string) return responseJson(allocator, .{
        .success = false,
        .@"error" = "Bun.color format must be a string",
        .code = "ERR_INVALID_ARG_TYPE",
        .name = "TypeError",
    });
    const format = OutputFormat.parse(format_value.string) orelse return responseJson(allocator, .{
        .success = false,
        .@"error" = "Invalid Bun.color format",
        .code = "ERR_INVALID_ARG_VALUE",
        .name = "TypeError",
    });

    var parsed_color = switch (try parseColorInput(allocator, value.object)) {
        .response => |response| return response,
        .parsed => |parsed| parsed,
    };
    return switch (parsed_color) {
        .err => responseJson(allocator, .{ .success = true, .result = null }),
        .result => |*color| responseJson(allocator, .{
            .success = true,
            .result = try formattedColor(allocator, color, format),
        }),
    };
}
