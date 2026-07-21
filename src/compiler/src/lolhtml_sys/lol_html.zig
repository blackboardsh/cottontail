const std = @import("std");
const bun = @import("bun");
const native = @import("html_rewriter");

const NativeRewriter = native.HtmlRewriter;
const NativeElement = native.units.element.Element;
const NativeEndTag = native.units.tokens.EndTag;
const NativeTextChunk = native.units.tokens.TextChunk;
const NativeComment = native.units.tokens.Comment;
const NativeDocType = native.units.tokens.Doctype;
const NativeDocEnd = native.units.document_end.DocumentEnd;
const NativeAttribute = native.units.tokens.Attribute;
const NativeElementHandlers = native.rewriter.content_handlers.ElementContentHandlers;
const NativeDocumentHandlers = native.rewriter.content_handlers.DocumentContentHandlers;
const NativeSelectorEntry = native.rewriter.api.SelectorHandlersEntry;
const ContentType = native.ContentType;

pub const Error = error{Fail};

pub const MemorySettings = extern struct {
    preallocated_parsing_buffer_size: usize,
    max_allowed_memory_usage: usize,
};

pub const SourceLocationBytes = extern struct {
    start: usize,
    end: usize,
};

const empty_bytes = [_]u8{0};
threadlocal var last_error_buffer: [512]u8 = undefined;
threadlocal var last_error_len: usize = 0;

inline fn auto_disable() void {
    if (comptime bun.FeatureFlags.disable_lolhtml) unreachable;
}

fn clearLastError() void {
    last_error_len = 0;
}

fn setLastError(message: []const u8) void {
    last_error_len = @min(message.len, last_error_buffer.len);
    @memcpy(last_error_buffer[0..last_error_len], message[0..last_error_len]);
}

fn captureError(err: anyerror) Error {
    setLastError(@errorName(err));
    return error.Fail;
}

fn contentType(is_html: bool) ContentType {
    return if (is_html) .html else .text;
}

fn stopped() anyerror {
    setLastError("The HTMLRewriter content handler stopped rewriting");
    return error.ContentHandlerStopped;
}

pub const HTMLString = struct {
    ptr: [*]const u8,
    len: usize,

    fn init(bytes: []const u8) HTMLString {
        return .{
            .ptr = if (bytes.len == 0) empty_bytes[0..].ptr else bytes.ptr,
            .len = bytes.len,
        };
    }

    pub fn deinit(_: HTMLString) void {}

    pub fn lastError() HTMLString {
        auto_disable();
        return init(last_error_buffer[0..last_error_len]);
    }

    pub fn slice(this: HTMLString) []const u8 {
        return this.ptr[0..this.len];
    }

    pub fn toString(this: HTMLString) bun.String {
        return bun.String.cloneUTF8(this.slice());
    }

    pub const toJS = @import("../runtime/api/lolhtml_jsc.zig").htmlStringToJS;
};

pub const Directive = enum(c_uint) {
    @"continue" = 0,
    stop = 1,
};

pub const lol_html_comment_handler_t = *const fn (*Comment, ?*anyopaque) callconv(.c) Directive;
pub const lol_html_text_handler_handler_t = *const fn (*TextChunk, ?*anyopaque) callconv(.c) Directive;
pub const lol_html_element_handler_t = *const fn (*Element, ?*anyopaque) callconv(.c) Directive;
pub const lol_html_doc_end_handler_t = *const fn (*DocEnd, ?*anyopaque) callconv(.c) Directive;
pub const lol_html_end_tag_handler_t = *const fn (*EndTag, ?*anyopaque) callconv(.c) Directive;

const ElementRegistration = struct {
    selector: []u8,
    element_handler: ?lol_html_element_handler_t,
    element_data: ?*anyopaque,
    comment_handler: ?lol_html_comment_handler_t,
    comment_data: ?*anyopaque,
    text_handler: ?lol_html_text_handler_handler_t,
    text_data: ?*anyopaque,
};

const DocumentRegistration = struct {
    doctype_handler: ?DirectiveFunctionType(DocType),
    doctype_data: ?*anyopaque,
    comment_handler: ?lol_html_comment_handler_t,
    comment_data: ?*anyopaque,
    text_handler: ?lol_html_text_handler_handler_t,
    text_data: ?*anyopaque,
    end_handler: ?lol_html_doc_end_handler_t,
    end_data: ?*anyopaque,
};

const ElementBridge = struct {
    registration: ElementRegistration,

    fn handleElement(ctx: ?*anyopaque, value: *NativeElement) anyerror!void {
        const this: *ElementBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.element_handler orelse return;
        var wrapped = Element{ .inner = value };
        if (callback(&wrapped, this.registration.element_data) == .stop) return stopped();
    }

    fn handleComment(ctx: ?*anyopaque, value: *NativeComment) anyerror!void {
        const this: *ElementBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.comment_handler orelse return;
        var wrapped = Comment{ .inner = value };
        if (callback(&wrapped, this.registration.comment_data) == .stop) return stopped();
    }

    fn handleText(ctx: ?*anyopaque, value: *NativeTextChunk) anyerror!void {
        const this: *ElementBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.text_handler orelse return;
        var wrapped = TextChunk{ .inner = value };
        if (callback(&wrapped, this.registration.text_data) == .stop) return stopped();
    }
};

const DocumentBridge = struct {
    registration: DocumentRegistration,

    fn handleDocType(ctx: ?*anyopaque, value: *NativeDocType) anyerror!void {
        const this: *DocumentBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.doctype_handler orelse return;
        var wrapped = DocType{ .inner = value };
        if (callback(&wrapped, this.registration.doctype_data) == .stop) return stopped();
    }

    fn handleComment(ctx: ?*anyopaque, value: *NativeComment) anyerror!void {
        const this: *DocumentBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.comment_handler orelse return;
        var wrapped = Comment{ .inner = value };
        if (callback(&wrapped, this.registration.comment_data) == .stop) return stopped();
    }

    fn handleText(ctx: ?*anyopaque, value: *NativeTextChunk) anyerror!void {
        const this: *DocumentBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.text_handler orelse return;
        var wrapped = TextChunk{ .inner = value };
        if (callback(&wrapped, this.registration.text_data) == .stop) return stopped();
    }

    fn handleEnd(ctx: ?*anyopaque, value: *NativeDocEnd) anyerror!void {
        const this: *DocumentBridge = @ptrCast(@alignCast(ctx.?));
        const callback = this.registration.end_handler orelse return;
        var wrapped = DocEnd{ .inner = value };
        if (callback(&wrapped, this.registration.end_data) == .stop) return stopped();
    }
};

const OutputBridge = struct {
    ctx: *anyopaque,
    write_fn: *const fn (*anyopaque, []const u8) void,
    done_fn: *const fn (*anyopaque) void,

    fn handleChunk(ctx: *anyopaque, chunk: []const u8) void {
        const this: *OutputBridge = @ptrCast(@alignCast(ctx));
        if (chunk.len == 0) {
            this.done_fn(this.ctx);
        } else {
            this.write_fn(this.ctx, chunk);
        }
    }
};

pub const HTMLRewriter = struct {
    inner: *NativeRewriter,
    element_bridges: []ElementBridge,
    document_bridges: []DocumentBridge,
    selector_sources: [][]u8,
    output: OutputBridge,

    pub fn write(this: *HTMLRewriter, chunk: []const u8) Error!void {
        auto_disable();
        clearLastError();
        this.inner.write(chunk) catch |err| return captureError(err);
    }

    pub fn end(this: *HTMLRewriter) Error!void {
        auto_disable();
        clearLastError();
        this.inner.end() catch |err| return captureError(err);
    }

    pub fn deinit(this: *HTMLRewriter) void {
        auto_disable();
        this.inner.deinit();
        for (this.selector_sources) |selector| {
            bun.default_allocator.free(selector);
        }
        bun.default_allocator.free(this.selector_sources);
        bun.default_allocator.free(this.element_bridges);
        bun.default_allocator.free(this.document_bridges);
        bun.default_allocator.destroy(this);
    }

    pub const Builder = struct {
        element_registrations: std.ArrayList(ElementRegistration) = .empty,
        document_registrations: std.ArrayList(DocumentRegistration) = .empty,

        pub fn init() *Builder {
            auto_disable();
            const builder = bun.default_allocator.create(Builder) catch @panic("out of memory");
            builder.* = .{};
            return builder;
        }

        pub fn deinit(this: *Builder) void {
            auto_disable();
            for (this.element_registrations.items) |registration| {
                bun.default_allocator.free(registration.selector);
            }
            this.element_registrations.deinit(bun.default_allocator);
            this.document_registrations.deinit(bun.default_allocator);
            bun.default_allocator.destroy(this);
        }

        pub fn addDocumentContentHandlers(
            builder: *Builder,
            comptime DocTypeHandler: type,
            comptime doctype_handler: ?DirectiveFunctionTypeForHandler(DocType, DocTypeHandler),
            doctype_handler_data: ?*DocTypeHandler,
            comptime CommentHandler: type,
            comptime comment_handler: ?DirectiveFunctionTypeForHandler(Comment, CommentHandler),
            comment_handler_data: ?*CommentHandler,
            comptime TextChunkHandler: type,
            comptime text_chunk_handler: ?DirectiveFunctionTypeForHandler(TextChunk, TextChunkHandler),
            text_chunk_handler_data: ?*TextChunkHandler,
            comptime DocEndHandler: type,
            comptime end_handler: ?DirectiveFunctionTypeForHandler(DocEnd, DocEndHandler),
            end_handler_data: ?*DocEndHandler,
        ) void {
            auto_disable();
            builder.document_registrations.append(bun.default_allocator, .{
                .doctype_handler = if (doctype_handler != null and doctype_handler_data != null)
                    DirectiveHandler(DocType, DocTypeHandler, doctype_handler.?)
                else
                    null,
                .doctype_data = if (doctype_handler_data) |data| @ptrCast(data) else null,
                .comment_handler = if (comment_handler != null and comment_handler_data != null)
                    DirectiveHandler(Comment, CommentHandler, comment_handler.?)
                else
                    null,
                .comment_data = if (comment_handler_data) |data| @ptrCast(data) else null,
                .text_handler = if (text_chunk_handler != null and text_chunk_handler_data != null)
                    DirectiveHandler(TextChunk, TextChunkHandler, text_chunk_handler.?)
                else
                    null,
                .text_data = if (text_chunk_handler_data) |data| @ptrCast(data) else null,
                .end_handler = if (end_handler != null and end_handler_data != null)
                    DirectiveHandler(DocEnd, DocEndHandler, end_handler.?)
                else
                    null,
                .end_data = if (end_handler_data) |data| @ptrCast(data) else null,
            }) catch @panic("out of memory");
        }

        pub fn addElementContentHandlers(
            builder: *Builder,
            selector: *HTMLSelector,
            comptime ElementHandler: type,
            comptime element_handler: ?DirectiveFunctionTypeForHandler(Element, ElementHandler),
            element_handler_data: ?*ElementHandler,
            comptime CommentHandler: type,
            comptime comment_handler: ?DirectiveFunctionTypeForHandler(Comment, CommentHandler),
            comment_handler_data: ?*CommentHandler,
            comptime TextChunkHandler: type,
            comptime text_chunk_handler: ?DirectiveFunctionTypeForHandler(TextChunk, TextChunkHandler),
            text_chunk_handler_data: ?*TextChunkHandler,
        ) Error!void {
            auto_disable();
            const selector_copy = bun.default_allocator.dupe(u8, selector.source) catch |err| return captureError(err);
            errdefer bun.default_allocator.free(selector_copy);
            builder.element_registrations.append(bun.default_allocator, .{
                .selector = selector_copy,
                .element_handler = if (element_handler != null and element_handler_data != null)
                    DirectiveHandler(Element, ElementHandler, element_handler.?)
                else
                    null,
                .element_data = if (element_handler_data) |data| @ptrCast(data) else null,
                .comment_handler = if (comment_handler != null and comment_handler_data != null)
                    DirectiveHandler(Comment, CommentHandler, comment_handler.?)
                else
                    null,
                .comment_data = if (comment_handler_data) |data| @ptrCast(data) else null,
                .text_handler = if (text_chunk_handler != null and text_chunk_handler_data != null)
                    DirectiveHandler(TextChunk, TextChunkHandler, text_chunk_handler.?)
                else
                    null,
                .text_data = if (text_chunk_handler_data) |data| @ptrCast(data) else null,
            }) catch |err| return captureError(err);
        }

        pub fn build(
            builder: *Builder,
            encoding: Encoding,
            memory_settings: MemorySettings,
            strict: bool,
            comptime OutputSink: type,
            output_sink: *OutputSink,
            comptime Writer: fn (*OutputSink, []const u8) void,
            comptime Done: fn (*OutputSink) void,
        ) Error!*HTMLRewriter {
            auto_disable();
            clearLastError();
            _ = memory_settings;
            if (encoding != .UTF8) {
                setLastError("zig-html-rewriter accepts UTF-8 input only");
                return error.Fail;
            }

            const allocator = bun.default_allocator;
            const this = allocator.create(HTMLRewriter) catch |err| return captureError(err);
            errdefer allocator.destroy(this);
            const element_bridges = allocator.alloc(ElementBridge, builder.element_registrations.items.len) catch |err| return captureError(err);
            errdefer allocator.free(element_bridges);
            const document_bridges = allocator.alloc(DocumentBridge, builder.document_registrations.items.len) catch |err| return captureError(err);
            errdefer allocator.free(document_bridges);
            const selector_sources = allocator.alloc([]u8, element_bridges.len) catch |err| return captureError(err);
            var selector_sources_initialized: usize = 0;
            errdefer {
                for (selector_sources[0..selector_sources_initialized]) |selector| {
                    allocator.free(selector);
                }
                allocator.free(selector_sources);
            }
            const selector_entries = allocator.alloc(NativeSelectorEntry, element_bridges.len) catch |err| return captureError(err);
            defer allocator.free(selector_entries);
            const document_entries = allocator.alloc(NativeDocumentHandlers, document_bridges.len) catch |err| return captureError(err);
            defer allocator.free(document_entries);

            for (builder.element_registrations.items, element_bridges, selector_entries, selector_sources) |registration, *bridge, *entry, *selector_source| {
                selector_source.* = allocator.dupe(u8, registration.selector) catch |err| return captureError(err);
                selector_sources_initialized += 1;
                bridge.* = .{ .registration = registration };
                bridge.registration.selector = selector_source.*;
                entry.* = .{
                    .selector = selector_source.*,
                    .handlers = NativeElementHandlers{
                        .element = if (registration.element_handler != null) .{
                            .ctx = @ptrCast(bridge),
                            .func = &ElementBridge.handleElement,
                        } else null,
                        .comments = if (registration.comment_handler != null) .{
                            .ctx = @ptrCast(bridge),
                            .func = &ElementBridge.handleComment,
                        } else null,
                        .text = if (registration.text_handler != null) .{
                            .ctx = @ptrCast(bridge),
                            .func = &ElementBridge.handleText,
                        } else null,
                    },
                };
            }
            for (builder.document_registrations.items, document_bridges, document_entries) |registration, *bridge, *entry| {
                bridge.* = .{ .registration = registration };
                entry.* = .{
                    .doctype = if (registration.doctype_handler != null) .{
                        .ctx = @ptrCast(bridge),
                        .func = &DocumentBridge.handleDocType,
                    } else null,
                    .comments = if (registration.comment_handler != null) .{
                        .ctx = @ptrCast(bridge),
                        .func = &DocumentBridge.handleComment,
                    } else null,
                    .text = if (registration.text_handler != null) .{
                        .ctx = @ptrCast(bridge),
                        .func = &DocumentBridge.handleText,
                    } else null,
                    .end = if (registration.end_handler != null) .{
                        .ctx = @ptrCast(bridge),
                        .func = &DocumentBridge.handleEnd,
                    } else null,
                };
            }

            this.* = .{
                .inner = undefined,
                .element_bridges = element_bridges,
                .document_bridges = document_bridges,
                .selector_sources = selector_sources,
                .output = .{
                    .ctx = @ptrCast(output_sink),
                    .write_fn = &struct {
                        fn call(ctx: *anyopaque, bytes: []const u8) void {
                            Writer(@ptrCast(@alignCast(ctx)), bytes);
                        }
                    }.call,
                    .done_fn = &struct {
                        fn call(ctx: *anyopaque) void {
                            Done(@ptrCast(@alignCast(ctx)));
                        }
                    }.call,
                },
            };
            this.inner = NativeRewriter.init(
                allocator,
                .{
                    .element_content_handlers = selector_entries,
                    .document_content_handlers = document_entries,
                    .strict = strict,
                },
                .{
                    .ctx = @ptrCast(&this.output),
                    .handle_chunk = &OutputBridge.handleChunk,
                },
            ) catch |err| return captureError(err);
            return this;
        }
    };
};

pub const HTMLSelector = struct {
    source: []u8,

    pub fn parse(selector: []const u8) Error!*HTMLSelector {
        auto_disable();
        clearLastError();
        var arena = std.heap.ArenaAllocator.init(bun.default_allocator);
        defer arena.deinit();
        _ = native.selectors.parser.parse(arena.allocator(), selector) catch |err| return captureError(err);
        const result = bun.default_allocator.create(HTMLSelector) catch |err| return captureError(err);
        errdefer bun.default_allocator.destroy(result);
        result.* = .{
            .source = bun.default_allocator.dupe(u8, selector) catch |err| return captureError(err),
        };
        return result;
    }

    pub fn deinit(selector: *HTMLSelector) void {
        auto_disable();
        bun.default_allocator.free(selector.source);
        bun.default_allocator.destroy(selector);
    }
};

pub const TextChunk = struct {
    inner: *NativeTextChunk,

    pub const Content = struct {
        ptr: [*]const u8,
        len: usize,

        pub fn slice(this: Content) []const u8 {
            return this.ptr[0..this.len];
        }
    };

    pub fn getContent(this: *const TextChunk) Content {
        const bytes = this.inner.asStr();
        return .{ .ptr = if (bytes.len == 0) empty_bytes[0..].ptr else bytes.ptr, .len = bytes.len };
    }

    pub fn isLastInTextNode(this: *const TextChunk) bool {
        return this.inner.lastInTextNode();
    }

    pub fn before(this: *TextChunk, content: []const u8, is_html: bool) Error!void {
        this.inner.before(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn after(this: *TextChunk, content: []const u8, is_html: bool) Error!void {
        this.inner.after(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn replace(this: *TextChunk, content: []const u8, is_html: bool) Error!void {
        this.inner.replace(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn remove(this: *TextChunk) void {
        this.inner.remove();
    }

    pub fn isRemoved(this: *const TextChunk) bool {
        return this.inner.removed();
    }

    pub fn setUserData(this: *const TextChunk, comptime Type: type, value: ?*Type) void {
        @constCast(this.inner).user_data = if (value) |ptr| @ptrCast(ptr) else null;
    }

    pub fn getUserData(this: *const TextChunk, comptime Type: type) ?*Type {
        return if (this.inner.user_data) |ptr| @ptrCast(@alignCast(ptr)) else null;
    }

    pub fn getSourceLocationBytes(_: *const TextChunk) SourceLocationBytes {
        // COTTONTAIL-COMPAT: The native port does not expose token spans yet.
        return .{ .start = 0, .end = 0 };
    }
};

pub const Element = struct {
    inner: *NativeElement,

    pub fn getAttribute(this: *const Element, name: []const u8) HTMLString {
        const value = this.inner.getAttribute(name) catch |err| {
            setLastError(@errorName(err));
            return HTMLString.init(&.{});
        };
        return HTMLString.init(value orelse &.{});
    }

    pub fn hasAttribute(this: *const Element, name: []const u8) Error!bool {
        return this.inner.hasAttribute(name) catch |err| return captureError(err);
    }

    pub fn setAttribute(this: *Element, name: []const u8, value: []const u8) Error!void {
        this.inner.setAttribute(name, value) catch |err| return captureError(err);
    }

    pub fn removeAttribute(this: *Element, name: []const u8) Error!void {
        this.inner.removeAttribute(name) catch |err| return captureError(err);
    }

    pub fn before(this: *Element, content: []const u8, is_html: bool) Error!void {
        this.inner.before(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn prepend(this: *Element, content: []const u8, is_html: bool) Error!void {
        this.inner.prepend(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn append(this: *Element, content: []const u8, is_html: bool) Error!void {
        this.inner.append(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn after(this: *Element, content: []const u8, is_html: bool) Error!void {
        this.inner.after(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn setInnerContent(this: *Element, content: []const u8, is_html: bool) Error!void {
        this.inner.setInnerContent(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn replace(this: *Element, content: []const u8, is_html: bool) Error!void {
        this.inner.replace(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn remove(this: *const Element) void {
        @constCast(this.inner).remove();
    }

    pub fn removeAndKeepContent(this: *const Element) void {
        @constCast(this.inner).removeAndKeepContent();
    }

    pub fn isRemoved(this: *const Element) bool {
        return this.inner.removed();
    }

    pub fn isSelfClosing(this: *const Element) bool {
        return this.inner.isSelfClosing();
    }

    pub fn canHaveContent(this: *const Element) bool {
        return this.inner.canHaveContent();
    }

    pub fn setUserData(this: *const Element, user_data: ?*anyopaque) void {
        @constCast(this.inner).user_data = user_data;
    }

    pub fn getUserData(this: *const Element, comptime Type: type) ?*Type {
        return if (this.inner.user_data) |ptr| @ptrCast(@alignCast(ptr)) else null;
    }

    pub fn onEndTag(this: *Element, callback: lol_html_end_tag_handler_t, user_data: ?*anyopaque) Error!void {
        const bridge = this.inner.allocator.create(EndTagBridge) catch |err| return captureError(err);
        bridge.* = .{ .callback = callback, .user_data = user_data };
        this.inner.end_tag_handlers.clearRetainingCapacity();
        this.inner.onEndTag(.{ .ctx = @ptrCast(bridge), .func = &EndTagBridge.handle }) catch |err| return captureError(err);
    }

    pub fn tagName(this: *const Element) HTMLString {
        const value = this.inner.tagName(this.inner.allocator) catch |err| {
            setLastError(@errorName(err));
            return HTMLString.init(&.{});
        };
        return HTMLString.init(value);
    }

    pub fn setTagName(this: *Element, name: []const u8) Error!void {
        this.inner.setTagName(name) catch |err| return captureError(err);
    }

    pub fn namespaceURI(this: *const Element) [*:0]const u8 {
        return this.inner.namespaceUri().ptr;
    }

    pub fn attributes(this: *const Element) ?*Attribute.Iterator {
        const iterator = bun.default_allocator.create(Attribute.Iterator) catch |err| {
            setLastError(@errorName(err));
            return null;
        };
        iterator.* = .{ .attributes = this.inner.attributes() };
        return iterator;
    }

    pub fn getSourceLocationBytes(_: *const Element) SourceLocationBytes {
        // COTTONTAIL-COMPAT: The native port does not expose token spans yet.
        return .{ .start = 0, .end = 0 };
    }
};

const EndTagBridge = struct {
    callback: lol_html_end_tag_handler_t,
    user_data: ?*anyopaque,

    fn handle(ctx: ?*anyopaque, value: *NativeEndTag) anyerror!void {
        const this: *EndTagBridge = @ptrCast(@alignCast(ctx.?));
        var wrapped = EndTag{ .inner = value };
        if (this.callback(&wrapped, this.user_data) == .stop) return stopped();
    }
};

pub const EndTag = struct {
    inner: *NativeEndTag,

    pub fn before(this: *EndTag, content: []const u8, is_html: bool) Error!void {
        this.inner.before(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn after(this: *EndTag, content: []const u8, is_html: bool) Error!void {
        this.inner.after(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn replace(this: *EndTag, content: []const u8, is_html: bool) Error!void {
        this.inner.replace(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn remove(this: *EndTag) void {
        this.inner.remove();
    }

    pub fn getName(this: *const EndTag) HTMLString {
        const value = this.inner.name(this.inner.allocator) catch |err| {
            setLastError(@errorName(err));
            return HTMLString.init(&.{});
        };
        return HTMLString.init(value);
    }

    pub fn setName(this: *EndTag, name: []const u8) Error!void {
        this.inner.setNameStr(name) catch |err| return captureError(err);
    }

    pub fn getSourceLocationBytes(_: *const EndTag) SourceLocationBytes {
        // COTTONTAIL-COMPAT: The native port does not expose token spans yet.
        return .{ .start = 0, .end = 0 };
    }
};

pub const Attribute = struct {
    inner: *const NativeAttribute,

    pub fn name(this: *const Attribute) HTMLString {
        return HTMLString.init(this.inner.name);
    }

    pub fn value(this: *const Attribute) HTMLString {
        return HTMLString.init(this.inner.value);
    }

    pub const Iterator = struct {
        attributes: []const NativeAttribute,
        index: usize = 0,
        current: Attribute = undefined,

        pub fn next(this: *Iterator) ?*const Attribute {
            if (this.index >= this.attributes.len) return null;
            this.current = .{ .inner = &this.attributes[this.index] };
            this.index += 1;
            return &this.current;
        }

        pub fn deinit(this: *Iterator) void {
            bun.default_allocator.destroy(this);
        }
    };
};

pub const Comment = struct {
    inner: *NativeComment,

    pub fn getText(this: *const Comment) HTMLString {
        return HTMLString.init(this.inner.text());
    }

    pub fn setText(this: *Comment, text: []const u8) Error!void {
        this.inner.setText(text) catch |err| return captureError(err);
    }

    pub fn before(this: *Comment, content: []const u8, is_html: bool) Error!void {
        this.inner.before(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn replace(this: *Comment, content: []const u8, is_html: bool) Error!void {
        this.inner.replace(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn after(this: *Comment, content: []const u8, is_html: bool) Error!void {
        this.inner.after(content, contentType(is_html)) catch |err| return captureError(err);
    }

    pub fn remove(this: *Comment) void {
        this.inner.remove();
    }

    pub fn isRemoved(this: *const Comment) bool {
        return this.inner.removed();
    }

    pub fn getSourceLocationBytes(_: *const Comment) SourceLocationBytes {
        // COTTONTAIL-COMPAT: The native port does not expose token spans yet.
        return .{ .start = 0, .end = 0 };
    }
};

pub const DocEnd = struct {
    inner: *NativeDocEnd,

    pub fn append(this: *DocEnd, content: []const u8, is_html: bool) Error!void {
        this.inner.append(content, contentType(is_html));
    }
};

fn DirectiveFunctionType(comptime Container: type) type {
    return *const fn (*Container, ?*anyopaque) callconv(.c) Directive;
}

fn DirectiveFunctionTypeForHandler(comptime Container: type, comptime UserDataType: type) type {
    return *const fn (*UserDataType, *Container) bool;
}

pub fn DirectiveHandler(
    comptime Container: type,
    comptime UserDataType: type,
    comptime Callback: *const fn (*UserDataType, *Container) bool,
) DirectiveFunctionType(Container) {
    return struct {
        pub fn callback(this: *Container, user_data: ?*anyopaque) callconv(.c) Directive {
            return if (Callback(@ptrCast(@alignCast(user_data.?)), this)) .stop else .@"continue";
        }
    }.callback;
}

pub const DocType = struct {
    inner: *NativeDocType,

    pub const Callback = *const fn (*DocType, ?*anyopaque) callconv(.c) Directive;

    pub fn getName(this: *const DocType) HTMLString {
        const value = this.inner.name(this.inner.allocator) catch |err| {
            setLastError(@errorName(err));
            return HTMLString.init(&.{});
        };
        return HTMLString.init(value orelse &.{});
    }

    pub fn getPublicId(this: *const DocType) HTMLString {
        return HTMLString.init(this.inner.publicId() orelse &.{});
    }

    pub fn getSystemId(this: *const DocType) HTMLString {
        return HTMLString.init(this.inner.systemId() orelse &.{});
    }

    pub fn remove(this: *DocType) void {
        this.inner.remove();
    }

    pub fn isRemoved(this: *const DocType) bool {
        return this.inner.removed();
    }

    pub fn getSourceLocationBytes(_: *const DocType) SourceLocationBytes {
        // COTTONTAIL-COMPAT: The native port does not expose token spans yet.
        return .{ .start = 0, .end = 0 };
    }
};

pub const Encoding = enum {
    UTF8,
    UTF16,
};

test "zig html rewriter compatibility adapter streams and mutates elements" {
    const Handler = struct {
        matched: usize = 0,

        fn onElement(this: *@This(), element: *Element) bool {
            this.matched += 1;
            element.setAttribute("data-runtime", "cottontail") catch return true;
            return false;
        }
    };
    const Sink = struct {
        output: std.ArrayList(u8) = .empty,
        completed: bool = false,

        fn write(this: *@This(), bytes: []const u8) void {
            this.output.appendSlice(bun.default_allocator, bytes) catch @panic("out of memory");
        }

        fn done(this: *@This()) void {
            this.completed = true;
        }
    };

    const builder = HTMLRewriter.Builder.init();
    var builder_live = true;
    defer if (builder_live) builder.deinit();
    const selector = try HTMLSelector.parse("*");
    var selector_live = true;
    defer if (selector_live) selector.deinit();

    var handler: Handler = .{};
    try builder.addElementContentHandlers(
        selector,
        Handler,
        Handler.onElement,
        &handler,
        void,
        null,
        null,
        void,
        null,
        null,
    );

    var sink: Sink = .{};
    defer sink.output.deinit(bun.default_allocator);
    const rewriter = try builder.build(
        .UTF8,
        .{
            .preallocated_parsing_buffer_size = 0,
            .max_allowed_memory_usage = 1024 * 1024,
        },
        true,
        Sink,
        &sink,
        Sink.write,
        Sink.done,
    );
    defer rewriter.deinit();

    builder.deinit();
    builder_live = false;
    selector.deinit();
    selector_live = false;

    try rewriter.write("<main><p>cotton");
    try rewriter.write("tail</p></main>");
    try rewriter.end();

    try std.testing.expectEqual(@as(usize, 2), handler.matched);
    try std.testing.expect(sink.completed);
    try std.testing.expectEqualStrings(
        "<main data-runtime=\"cottontail\"><p data-runtime=\"cottontail\">cottontail</p></main>",
        sink.output.items,
    );
}
