const std = @import("std");
const bun = @import("bun");

const c_allocator = std.heap.c_allocator;

fn setError(error_out: *?[*:0]u8, comptime fmt: []const u8, args: anytype) void {
    const message = std.fmt.allocPrintSentinel(c_allocator, fmt, args, 0) catch {
        error_out.* = null;
        return;
    };
    error_out.* = message.ptr;
}

fn option(flags: u64, bit: u6) bool {
    return flags & (@as(u64, 1) << bit) != 0;
}

fn optionsFromFlags(flags: u64) bun.md.Options {
    return .{
        .tables = option(flags, 0),
        .strikethrough = option(flags, 1),
        .tasklists = option(flags, 2),
        .permissive_autolinks = option(flags, 3),
        .permissive_url_autolinks = option(flags, 4),
        .permissive_www_autolinks = option(flags, 5),
        .permissive_email_autolinks = option(flags, 6),
        .hard_soft_breaks = option(flags, 7),
        .wiki_links = option(flags, 8),
        .underline = option(flags, 9),
        .latex_math = option(flags, 10),
        .collapse_whitespace = option(flags, 11),
        .permissive_atx_headers = option(flags, 12),
        .no_indented_code_blocks = option(flags, 13),
        .no_html_blocks = option(flags, 14),
        .no_html_spans = option(flags, 15),
        .tag_filter = option(flags, 16),
        .heading_ids = option(flags, 17),
        .autolink_headings = option(flags, 18),
    };
}

const EventRenderer = struct {
    allocator: std.mem.Allocator,
    output: std.ArrayListUnmanaged(u8) = .empty,
    first: bool = true,
    heading_tracker: bun.md.helpers.HeadingIdTracker,

    fn init(allocator: std.mem.Allocator, heading_ids: bool) !EventRenderer {
        var result = EventRenderer{
            .allocator = allocator,
            .heading_tracker = bun.md.helpers.HeadingIdTracker.init(heading_ids),
        };
        try result.output.append(allocator, '[');
        return result;
    }

    fn deinit(self: *EventRenderer) void {
        self.output.deinit(self.allocator);
        self.heading_tracker.deinit(self.allocator);
    }

    fn renderer(self: *EventRenderer) bun.md.Renderer {
        return .{ .ptr = self, .vtable = &vtable };
    }

    const vtable: bun.md.Renderer.VTable = .{
        .enterBlock = enterBlock,
        .leaveBlock = leaveBlock,
        .enterSpan = enterSpan,
        .leaveSpan = leaveSpan,
        .text = text,
    };

    fn startEvent(self: *EventRenderer) !void {
        if (!self.first) try self.output.append(self.allocator, ',');
        self.first = false;
    }

    fn appendJsonString(self: *EventRenderer, value: []const u8) !void {
        const encoded = try std.json.Stringify.valueAlloc(
            self.allocator,
            std.json.Value{ .string = value },
            .{},
        );
        defer self.allocator.free(encoded);
        try self.output.appendSlice(self.allocator, encoded);
    }

    fn appendFormatted(self: *EventRenderer, comptime format: []const u8, args: anytype) error{OutOfMemory}!void {
        var buffer: [128]u8 = undefined;
        const value = std.fmt.bufPrint(&buffer, format, args) catch unreachable;
        try self.output.appendSlice(self.allocator, value);
    }

    fn enterBlock(ptr: *anyopaque, block_type: bun.md.BlockType, data: u32, flags: u32) bun.JSError!void {
        const self: *EventRenderer = @ptrCast(@alignCast(ptr));
        if (block_type == .h) self.heading_tracker.enterHeading();
        try self.startEvent();
        try self.appendFormatted("[\"b\",{d},{d},{d}]", .{ @intFromEnum(block_type), data, flags });
    }

    fn leaveBlock(ptr: *anyopaque, block_type: bun.md.BlockType, _: u32) bun.JSError!void {
        const self: *EventRenderer = @ptrCast(@alignCast(ptr));
        const slug = if (block_type == .h) self.heading_tracker.leaveHeading(self.allocator) else null;
        try self.startEvent();
        try self.appendFormatted("[\"B\",{d},", .{@intFromEnum(block_type)});
        if (slug) |value| try self.appendJsonString(value) else try self.output.appendSlice(self.allocator, "null");
        try self.output.append(self.allocator, ']');
        if (block_type == .h) self.heading_tracker.clearAfterHeading();
    }

    fn enterSpan(ptr: *anyopaque, span_type: bun.md.SpanType, detail: bun.md.SpanDetail) bun.JSError!void {
        const self: *EventRenderer = @ptrCast(@alignCast(ptr));
        try self.startEvent();
        try self.appendFormatted("[\"s\",{d},", .{@intFromEnum(span_type)});
        try self.appendJsonString(detail.href);
        try self.output.append(self.allocator, ',');
        try self.appendJsonString(detail.title);
        try self.output.append(self.allocator, ']');
    }

    fn leaveSpan(ptr: *anyopaque, span_type: bun.md.SpanType) bun.JSError!void {
        const self: *EventRenderer = @ptrCast(@alignCast(ptr));
        try self.startEvent();
        try self.appendFormatted("[\"S\",{d}]", .{@intFromEnum(span_type)});
    }

    fn text(ptr: *anyopaque, text_type: bun.md.TextType, content: []const u8) bun.JSError!void {
        const self: *EventRenderer = @ptrCast(@alignCast(ptr));
        self.heading_tracker.trackText(text_type, content, self.allocator);
        var entity_buffer: [8]u8 = undefined;
        const rendered = switch (text_type) {
            .null_char => "\xEF\xBF\xBD",
            .br, .softbr => "\n",
            .entity => bun.md.helpers.decodeEntityToUtf8(content, &entity_buffer) orelse content,
            else => content,
        };
        try self.startEvent();
        try self.appendFormatted("[\"t\",{d},", .{@intFromEnum(text_type)});
        try self.appendJsonString(rendered);
        try self.output.append(self.allocator, ']');
    }

    fn finish(self: *EventRenderer) ![]u8 {
        try self.output.append(self.allocator, ']');
        return self.output.toOwnedSlice(self.allocator);
    }
};

export fn ct_markdown_render_html(
    source_ptr: ?[*]const u8,
    source_len: usize,
    flags: u64,
    output_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;

    const source = if (source_ptr) |ptr| ptr[0..source_len] else if (source_len == 0) "" else {
        setError(error_out, "Markdown source pointer is null", .{});
        return null;
    };
    const rendered = bun.md.renderToHtmlWithOptions(source, c_allocator, optionsFromFlags(flags)) catch |err| {
        setError(error_out, "Markdown rendering failed: {s}", .{@errorName(err)});
        return null;
    };
    output_len.* = rendered.len;
    return rendered.ptr;
}

export fn ct_markdown_parse_events(
    source_ptr: ?[*]const u8,
    source_len: usize,
    flags: u64,
    output_len: *usize,
    error_out: *?[*:0]u8,
) ?[*]u8 {
    output_len.* = 0;
    error_out.* = null;

    const source = if (source_ptr) |ptr| ptr[0..source_len] else if (source_len == 0) "" else {
        setError(error_out, "Markdown source pointer is null", .{});
        return null;
    };
    const options = optionsFromFlags(flags);
    var event_renderer = EventRenderer.init(c_allocator, options.heading_ids) catch |err| {
        setError(error_out, "Markdown event renderer initialization failed: {s}", .{@errorName(err)});
        return null;
    };
    defer event_renderer.deinit();
    bun.md.renderWithRenderer(source, c_allocator, options, event_renderer.renderer()) catch |err| {
        setError(error_out, "Markdown parsing failed: {s}", .{@errorName(err)});
        return null;
    };
    const rendered = event_renderer.finish() catch |err| {
        setError(error_out, "Markdown event serialization failed: {s}", .{@errorName(err)});
        return null;
    };
    output_len.* = rendered.len;
    return rendered.ptr;
}

export fn ct_markdown_free(ptr: ?[*]u8, len: usize) void {
    if (ptr) |value| c_allocator.free(value[0..len]);
}

export fn ct_markdown_string_free(ptr: ?[*:0]u8) void {
    if (ptr) |value| c_allocator.free(std.mem.span(value));
}

pub fn forceLink() void {
    _ = &ct_markdown_render_html;
    _ = &ct_markdown_parse_events;
    _ = &ct_markdown_free;
    _ = &ct_markdown_string_free;
}
