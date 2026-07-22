const std = @import("std");

const node_type_names = [_][]const u8{
    "hidden",
    "array",
    "string",
    "object",
    "code",
    "closure",
    "regexp",
    "number",
    "native",
    "synthetic",
    "concatenated string",
    "sliced string",
    "symbol",
    "bigint",
};

const edge_type_names = [_][]const u8{
    "context",
    "element",
    "property",
    "internal",
    "hidden",
    "shortcut",
    "weak",
};

const v8_node_fields = [_][]const u8{
    "type",
    "name",
    "id",
    "self_size",
    "edge_count",
    "trace_node_id",
    "detachedness",
};

const v8_edge_fields = [_][]const u8{ "type", "name_or_index", "to_node" };
const v8_trace_function_info_fields = [_][]const u8{ "function_id", "name", "script_name", "script_id", "line", "column" };
const v8_trace_node_fields = [_][]const u8{ "id", "function_info_index", "count", "size", "children" };
const v8_sample_fields = [_][]const u8{ "timestamp_us", "last_assigned_id" };
const v8_location_fields = [_][]const u8{ "object_index", "script_id", "line", "column" };
const v8_node_types = .{
    node_type_names[0..],
    @as([]const u8, "string"),
    @as([]const u8, "number"),
    @as([]const u8, "number"),
    @as([]const u8, "number"),
    @as([]const u8, "number"),
    @as([]const u8, "number"),
};
const v8_edge_types = .{
    edge_type_names[0..],
    @as([]const u8, "string_or_number"),
    @as([]const u8, "node"),
};

const HeapNode = struct {
    id: u64,
    size: u64,
    class_name_index: usize,
    flags: u64,
    label_index: ?usize,
    retained_size: u64 = 0,
    dominator: usize = 0,
    is_gc_root: bool = false,
};

const HeapEdge = struct {
    from_id: u64,
    to_id: u64,
    type_index: usize,
    data_index: u64,
    from_index: ?usize,
    to_index: ?usize,
};

const HeapGraph = struct {
    nodes: []HeapNode,
    edges: []HeapEdge,
    class_names: []const []const u8,
    edge_types: []const []const u8,
    edge_names: []const []const u8,
    labels: []const []const u8,
    outgoing_offsets: []usize,
    outgoing_edges: []usize,
    incoming_offsets: []usize,
    incoming_edges: []usize,

    fn className(self: HeapGraph, node: HeapNode) []const u8 {
        return stringAt(self.class_names, node.class_name_index) orelse "(unknown)";
    }

    fn label(self: HeapGraph, node: HeapNode) []const u8 {
        return stringAt(self.labels, node.label_index orelse return "") orelse "";
    }

    fn edgeType(self: HeapGraph, edge: HeapEdge) []const u8 {
        return stringAt(self.edge_types, edge.type_index) orelse "?";
    }

    fn edgeName(self: HeapGraph, edge: HeapEdge) []const u8 {
        const edge_type = self.edgeType(edge);
        if (!std.mem.eql(u8, edge_type, "Property") and !std.mem.eql(u8, edge_type, "Variable")) return "";
        const index = std.math.cast(usize, edge.data_index) orelse return "";
        return stringAt(self.edge_names, index) orelse "";
    }

    fn outgoing(self: HeapGraph, node_index: usize) []const usize {
        return self.outgoing_edges[self.outgoing_offsets[node_index]..self.outgoing_offsets[node_index + 1]];
    }

    fn incoming(self: HeapGraph, node_index: usize) []const usize {
        return self.incoming_edges[self.incoming_offsets[node_index]..self.incoming_offsets[node_index + 1]];
    }
};

const TypeStats = struct {
    name: []const u8,
    total_size: u64 = 0,
    total_retained_size: u64 = 0,
    count: usize = 0,
    largest_retained: u64 = 0,
    largest_instance_id: u64 = 0,
};

fn stringAt(values: []const []const u8, index: usize) ?[]const u8 {
    if (index >= values.len) return null;
    return values[index];
}

const JsonSpan = struct {
    bytes: []const u8,
};

const JsonStringRange = struct {
    bytes: []const u8,
    escaped: bool,
};

fn hexDigit(byte: u8) ?u32 {
    return switch (byte) {
        '0'...'9' => byte - '0',
        'a'...'f' => byte - 'a' + 10,
        'A'...'F' => byte - 'A' + 10,
        else => null,
    };
}

fn decodeHex4(bytes: []const u8) !u32 {
    if (bytes.len < 4) return error.InvalidHeapSnapshot;
    var value: u32 = 0;
    for (bytes[0..4]) |byte| value = value * 16 + (hexDigit(byte) orelse return error.InvalidHeapSnapshot);
    return value;
}

fn appendUtf8(output: []u8, output_index: *usize, codepoint: u32) !void {
    const index = output_index.*;
    if (codepoint <= 0x7f) {
        output[index] = @intCast(codepoint);
        output_index.* += 1;
    } else if (codepoint <= 0x7ff) {
        output[index] = @intCast(0xc0 | (codepoint >> 6));
        output[index + 1] = @intCast(0x80 | (codepoint & 0x3f));
        output_index.* += 2;
    } else if (codepoint <= 0xffff) {
        output[index] = @intCast(0xe0 | (codepoint >> 12));
        output[index + 1] = @intCast(0x80 | ((codepoint >> 6) & 0x3f));
        output[index + 2] = @intCast(0x80 | (codepoint & 0x3f));
        output_index.* += 3;
    } else if (codepoint <= 0x10ffff) {
        output[index] = @intCast(0xf0 | (codepoint >> 18));
        output[index + 1] = @intCast(0x80 | ((codepoint >> 12) & 0x3f));
        output[index + 2] = @intCast(0x80 | ((codepoint >> 6) & 0x3f));
        output[index + 3] = @intCast(0x80 | (codepoint & 0x3f));
        output_index.* += 4;
    } else return error.InvalidHeapSnapshot;
}

fn decodeJsonString(allocator: std.mem.Allocator, raw: []const u8) ![]const u8 {
    const output = try allocator.alloc(u8, raw.len);
    var input_index: usize = 0;
    var output_index: usize = 0;
    while (input_index < raw.len) {
        const byte = raw[input_index];
        input_index += 1;
        if (byte != '\\') {
            output[output_index] = byte;
            output_index += 1;
            continue;
        }
        if (input_index >= raw.len) return error.InvalidHeapSnapshot;
        const escape = raw[input_index];
        input_index += 1;
        switch (escape) {
            '"', '\\', '/' => {
                output[output_index] = escape;
                output_index += 1;
            },
            'b' => {
                output[output_index] = 8;
                output_index += 1;
            },
            'f' => {
                output[output_index] = 12;
                output_index += 1;
            },
            'n' => {
                output[output_index] = '\n';
                output_index += 1;
            },
            'r' => {
                output[output_index] = '\r';
                output_index += 1;
            },
            't' => {
                output[output_index] = '\t';
                output_index += 1;
            },
            'u' => {
                var codepoint = try decodeHex4(raw[input_index..]);
                input_index += 4;
                if (codepoint >= 0xd800 and codepoint <= 0xdbff) {
                    if (input_index + 6 > raw.len or raw[input_index] != '\\' or raw[input_index + 1] != 'u') {
                        return error.InvalidHeapSnapshot;
                    }
                    const low = try decodeHex4(raw[input_index + 2 ..]);
                    if (low < 0xdc00 or low > 0xdfff) return error.InvalidHeapSnapshot;
                    input_index += 6;
                    codepoint = 0x10000 + ((codepoint - 0xd800) << 10) + (low - 0xdc00);
                } else if (codepoint >= 0xdc00 and codepoint <= 0xdfff) return error.InvalidHeapSnapshot;
                try appendUtf8(output, &output_index, codepoint);
            },
            else => return error.InvalidHeapSnapshot,
        }
    }
    return output[0..output_index];
}

const JsonCursor = struct {
    source: []const u8,
    index: usize = 0,

    fn skipWhitespace(self: *@This()) void {
        while (self.index < self.source.len) {
            switch (self.source[self.index]) {
                ' ', '\t', '\r', '\n' => self.index += 1,
                else => return,
            }
        }
    }

    fn consume(self: *@This(), expected: u8) bool {
        self.skipWhitespace();
        if (self.index >= self.source.len or self.source[self.index] != expected) return false;
        self.index += 1;
        return true;
    }

    fn expect(self: *@This(), expected: u8) !void {
        if (!self.consume(expected)) return error.InvalidHeapSnapshot;
    }

    fn parseStringRange(self: *@This()) !JsonStringRange {
        self.skipWhitespace();
        if (self.index >= self.source.len or self.source[self.index] != '"') return error.InvalidHeapSnapshot;
        self.index += 1;
        const start = self.index;
        var escaped = false;
        while (self.index < self.source.len) {
            const byte = self.source[self.index];
            self.index += 1;
            switch (byte) {
                '"' => return .{ .bytes = self.source[start .. self.index - 1], .escaped = escaped },
                '\\' => {
                    escaped = true;
                    if (self.index >= self.source.len) return error.InvalidHeapSnapshot;
                    const escape = self.source[self.index];
                    self.index += 1;
                    switch (escape) {
                        '"', '\\', '/', 'b', 'f', 'n', 'r', 't' => {},
                        'u' => {
                            if (self.index + 4 > self.source.len) return error.InvalidHeapSnapshot;
                            _ = try decodeHex4(self.source[self.index..]);
                            self.index += 4;
                        },
                        else => return error.InvalidHeapSnapshot,
                    }
                },
                0...31 => return error.InvalidHeapSnapshot,
                else => {},
            }
        }
        return error.InvalidHeapSnapshot;
    }

    fn parseString(self: *@This(), allocator: std.mem.Allocator) ![]const u8 {
        const range = try self.parseStringRange();
        return if (range.escaped) try decodeJsonString(allocator, range.bytes) else range.bytes;
    }

    fn skipValue(self: *@This()) !void {
        self.skipWhitespace();
        if (self.index >= self.source.len) return error.InvalidHeapSnapshot;
        if (self.source[self.index] == '"') {
            _ = try self.parseStringRange();
            return;
        }
        if (self.source[self.index] == '[' or self.source[self.index] == '{') {
            var depth: usize = 0;
            while (self.index < self.source.len) {
                switch (self.source[self.index]) {
                    '"' => _ = try self.parseStringRange(),
                    '[', '{' => {
                        depth += 1;
                        self.index += 1;
                    },
                    ']', '}' => {
                        if (depth == 0) return error.InvalidHeapSnapshot;
                        depth -= 1;
                        self.index += 1;
                        if (depth == 0) return;
                    },
                    else => self.index += 1,
                }
            }
            return error.InvalidHeapSnapshot;
        }
        const start = self.index;
        while (self.index < self.source.len) : (self.index += 1) {
            switch (self.source[self.index]) {
                ',', ']', '}', ' ', '\t', '\r', '\n' => break,
                else => {},
            }
        }
        if (self.index == start) return error.InvalidHeapSnapshot;
    }
};

const SnapshotFields = struct {
    gc_debugging: bool,
    nodes: JsonSpan,
    edges: JsonSpan,
    class_names: ?JsonSpan = null,
    edge_types: ?JsonSpan = null,
    edge_names: ?JsonSpan = null,
    labels: ?JsonSpan = null,
    roots: ?JsonSpan = null,
};

fn parseSnapshotFields(allocator: std.mem.Allocator, source: []const u8) !SnapshotFields {
    var cursor = JsonCursor{ .source = source };
    try cursor.expect('{');
    var snapshot_type: ?[]const u8 = null;
    var nodes: ?JsonSpan = null;
    var edges: ?JsonSpan = null;
    var class_names: ?JsonSpan = null;
    var edge_types: ?JsonSpan = null;
    var edge_names: ?JsonSpan = null;
    var labels: ?JsonSpan = null;
    var roots: ?JsonSpan = null;
    var first = true;
    while (true) {
        cursor.skipWhitespace();
        if (cursor.consume('}')) break;
        if (!first) try cursor.expect(',');
        first = false;
        const key = try cursor.parseString(allocator);
        try cursor.expect(':');
        if (std.mem.eql(u8, key, "type")) {
            snapshot_type = try cursor.parseString(allocator);
            continue;
        }
        cursor.skipWhitespace();
        const start = cursor.index;
        try cursor.skipValue();
        const span = JsonSpan{ .bytes = source[start..cursor.index] };
        if (span.bytes.len == 0 or span.bytes[0] != '[') {
            if (std.mem.eql(u8, key, "nodes") or std.mem.eql(u8, key, "edges")) return error.InvalidHeapSnapshot;
            continue;
        }
        if (std.mem.eql(u8, key, "nodes")) nodes = span else if (std.mem.eql(u8, key, "edges")) edges = span else if (std.mem.eql(u8, key, "nodeClassNames")) class_names = span else if (std.mem.eql(u8, key, "edgeTypes")) edge_types = span else if (std.mem.eql(u8, key, "edgeNames")) edge_names = span else if (std.mem.eql(u8, key, "labels")) labels = span else if (std.mem.eql(u8, key, "roots")) roots = span;
    }
    cursor.skipWhitespace();
    if (cursor.index != source.len) return error.InvalidHeapSnapshot;
    const actual_type = snapshot_type orelse return error.InvalidHeapSnapshot;
    const gc_debugging = std.mem.eql(u8, actual_type, "GCDebugging");
    if (!gc_debugging and !std.mem.eql(u8, actual_type, "Inspector")) return error.InvalidHeapSnapshot;
    return .{
        .gc_debugging = gc_debugging,
        .nodes = nodes orelse return error.InvalidHeapSnapshot,
        .edges = edges orelse return error.InvalidHeapSnapshot,
        .class_names = class_names,
        .edge_types = edge_types,
        .edge_names = edge_names,
        .labels = labels,
        .roots = roots,
    };
}

fn numberArrayCount(span: JsonSpan) !usize {
    if (span.bytes.len < 2 or span.bytes[0] != '[' or span.bytes[span.bytes.len - 1] != ']') return error.InvalidHeapSnapshot;
    const body = std.mem.trim(u8, span.bytes[1 .. span.bytes.len - 1], " \t\r\n");
    return if (body.len == 0) 0 else std.mem.count(u8, body, ",") + 1;
}

const UnsignedArrayParser = struct {
    cursor: JsonCursor,
    consumed: usize = 0,

    fn init(span: JsonSpan) !@This() {
        var result = @This(){ .cursor = .{ .source = span.bytes } };
        try result.cursor.expect('[');
        return result;
    }

    fn next(self: *@This()) !u64 {
        if (self.consumed > 0) try self.cursor.expect(',');
        self.cursor.skipWhitespace();
        const start = self.cursor.index;
        var result: u64 = 0;
        while (self.cursor.index < self.cursor.source.len) {
            const byte = self.cursor.source[self.cursor.index];
            if (byte < '0' or byte > '9') break;
            result = std.math.mul(u64, result, 10) catch return error.InvalidHeapSnapshot;
            result = std.math.add(u64, result, byte - '0') catch return error.InvalidHeapSnapshot;
            self.cursor.index += 1;
        }
        if (self.cursor.index == start) return error.InvalidHeapSnapshot;
        self.consumed += 1;
        return result;
    }

    fn skip(self: *@This()) !void {
        if (self.consumed > 0) try self.cursor.expect(',');
        try self.cursor.skipValue();
        self.consumed += 1;
    }

    fn finish(self: *@This()) !void {
        try self.cursor.expect(']');
        self.cursor.skipWhitespace();
        if (self.cursor.index != self.cursor.source.len) return error.InvalidHeapSnapshot;
    }
};

fn stringArrayCount(span: JsonSpan) !usize {
    var cursor = JsonCursor{ .source = span.bytes };
    try cursor.expect('[');
    if (cursor.consume(']')) return 0;
    var count: usize = 0;
    while (true) {
        if (count > 0) try cursor.expect(',');
        _ = try cursor.parseStringRange();
        count += 1;
        if (cursor.consume(']')) break;
    }
    cursor.skipWhitespace();
    if (cursor.index != cursor.source.len) return error.InvalidHeapSnapshot;
    return count;
}

fn parseStringArray(allocator: std.mem.Allocator, optional_span: ?JsonSpan) ![]const []const u8 {
    const span = optional_span orelse return &.{};
    const count = try stringArrayCount(span);
    const values = try allocator.alloc([]const u8, count);
    var cursor = JsonCursor{ .source = span.bytes };
    try cursor.expect('[');
    for (values, 0..) |*value, index| {
        if (index > 0) try cursor.expect(',');
        value.* = try cursor.parseString(allocator);
    }
    try cursor.expect(']');
    cursor.skipWhitespace();
    if (cursor.index != cursor.source.len) return error.InvalidHeapSnapshot;
    return values;
}

fn parseGraph(allocator: std.mem.Allocator, source: []const u8) !HeapGraph {
    const fields = try parseSnapshotFields(allocator, source);
    const node_stride: usize = if (fields.gc_debugging) 7 else 4;
    const node_value_count = try numberArrayCount(fields.nodes);
    const edge_value_count = try numberArrayCount(fields.edges);
    if (node_value_count % node_stride != 0 or edge_value_count % 4 != 0) return error.InvalidHeapSnapshot;

    const node_count = node_value_count / node_stride;
    const nodes = try allocator.alloc(HeapNode, node_count);
    var id_to_index: std.AutoHashMapUnmanaged(u64, usize) = .empty;
    const hash_capacity = std.math.cast(u32, node_count) orelse return error.HeapSnapshotTooLarge;
    try id_to_index.ensureTotalCapacity(allocator, hash_capacity);
    var node_values = try UnsignedArrayParser.init(fields.nodes);
    for (nodes, 0..) |*node, index| {
        const id = try node_values.next();
        const size = try node_values.next();
        const class_name_index = std.math.cast(usize, try node_values.next()) orelse return error.InvalidHeapSnapshot;
        const flags = try node_values.next();
        const label_index = if (fields.gc_debugging)
            std.math.cast(usize, try node_values.next()) orelse return error.InvalidHeapSnapshot
        else
            null;
        if (fields.gc_debugging) {
            try node_values.skip();
            try node_values.skip();
        }
        node.* = .{
            .id = id,
            .size = size,
            .class_name_index = class_name_index,
            .flags = flags,
            .label_index = label_index,
        };
        try id_to_index.put(allocator, id, index);
    }
    try node_values.finish();

    const edge_count = edge_value_count / 4;
    const edges = try allocator.alloc(HeapEdge, edge_count);
    const outgoing_offsets = try allocator.alloc(usize, node_count + 1);
    const incoming_offsets = try allocator.alloc(usize, node_count + 1);
    @memset(outgoing_offsets, 0);
    @memset(incoming_offsets, 0);
    var linked_edge_count: usize = 0;
    var edge_values = try UnsignedArrayParser.init(fields.edges);
    for (edges) |*edge| {
        const from_id = try edge_values.next();
        const to_id = try edge_values.next();
        const type_index = std.math.cast(usize, try edge_values.next()) orelse return error.InvalidHeapSnapshot;
        const data_index = try edge_values.next();
        const from_index = id_to_index.get(from_id);
        const to_index = id_to_index.get(to_id);
        edge.* = .{
            .from_id = from_id,
            .to_id = to_id,
            .type_index = type_index,
            .data_index = data_index,
            .from_index = from_index,
            .to_index = to_index,
        };
        if (from_index != null and to_index != null) {
            outgoing_offsets[from_index.? + 1] += 1;
            incoming_offsets[to_index.? + 1] += 1;
            linked_edge_count += 1;
        }
    }
    try edge_values.finish();

    for (0..node_count) |index| {
        outgoing_offsets[index + 1] += outgoing_offsets[index];
        incoming_offsets[index + 1] += incoming_offsets[index];
    }
    const outgoing_edges = try allocator.alloc(usize, linked_edge_count);
    const incoming_edges = try allocator.alloc(usize, linked_edge_count);
    const outgoing_cursor = try allocator.dupe(usize, outgoing_offsets[0..node_count]);
    const incoming_cursor = try allocator.dupe(usize, incoming_offsets[0..node_count]);
    for (edges, 0..) |edge, edge_index| {
        if (edge.from_index == null or edge.to_index == null) continue;
        outgoing_edges[outgoing_cursor[edge.from_index.?]] = edge_index;
        outgoing_cursor[edge.from_index.?] += 1;
        incoming_edges[incoming_cursor[edge.to_index.?]] = edge_index;
        incoming_cursor[edge.to_index.?] += 1;
    }

    if (fields.roots) |roots| {
        const root_value_count = try numberArrayCount(roots);
        var root_values = try UnsignedArrayParser.init(roots);
        for (0..root_value_count) |offset| {
            const value = try root_values.next();
            if (offset % 3 == 0) {
                if (id_to_index.get(value)) |index| nodes[index].is_gc_root = true;
            }
        }
        try root_values.finish();
    }

    return .{
        .nodes = nodes,
        .edges = edges,
        .class_names = try parseStringArray(allocator, fields.class_names),
        .edge_types = try parseStringArray(allocator, fields.edge_types),
        .edge_names = try parseStringArray(allocator, fields.edge_names),
        .labels = try parseStringArray(allocator, fields.labels),
        .outgoing_offsets = outgoing_offsets,
        .outgoing_edges = outgoing_edges,
        .incoming_offsets = incoming_offsets,
        .incoming_edges = incoming_edges,
    };
}

fn containsIgnoreCase(haystack: []const u8, needle: []const u8) bool {
    if (needle.len > haystack.len) return false;
    var index: usize = 0;
    while (index + needle.len <= haystack.len) : (index += 1) {
        if (std.ascii.eqlIgnoreCase(haystack[index .. index + needle.len], needle)) return true;
    }
    return false;
}

fn v8NodeType(class_name: []const u8, flags: u64, id: u64) u64 {
    if (id == 0 or std.mem.eql(u8, class_name, "<root>")) return 9;
    if (containsIgnoreCase(class_name, "symbol")) return 12;
    if (containsIgnoreCase(class_name, "bigint")) return 13;
    if (containsIgnoreCase(class_name, "regexp")) return 6;
    if (containsIgnoreCase(class_name, "function") or containsIgnoreCase(class_name, "closure")) return 5;
    if (containsIgnoreCase(class_name, "code") or containsIgnoreCase(class_name, "executable")) return 4;
    if (containsIgnoreCase(class_name, "string")) return 2;
    if (containsIgnoreCase(class_name, "array")) return 1;
    if (containsIgnoreCase(class_name, "number") or containsIgnoreCase(class_name, "double") or containsIgnoreCase(class_name, "int32")) return 7;
    if ((flags & 1) != 0) return 0;
    return 3;
}

fn v8EdgeType(edge_type: []const u8) u64 {
    if (std.mem.eql(u8, edge_type, "Variable")) return 0;
    if (std.mem.eql(u8, edge_type, "Index")) return 1;
    if (std.mem.eql(u8, edge_type, "Property")) return 2;
    if (std.mem.eql(u8, edge_type, "Internal")) return 3;
    return 4;
}

fn internString(
    allocator: std.mem.Allocator,
    indexes: *std.StringHashMapUnmanaged(u64),
    strings: *std.ArrayList([]const u8),
    value: []const u8,
) !u64 {
    if (indexes.get(value)) |index| return index;
    const index: u64 = @intCast(strings.items.len);
    try strings.append(allocator, value);
    try indexes.put(allocator, value, index);
    return index;
}

const V8Meta = struct {
    node_fields: []const []const u8 = v8_node_fields[0..],
    node_types: @TypeOf(v8_node_types) = v8_node_types,
    edge_fields: []const []const u8 = v8_edge_fields[0..],
    edge_types: @TypeOf(v8_edge_types) = v8_edge_types,
    trace_function_info_fields: []const []const u8 = v8_trace_function_info_fields[0..],
    trace_node_fields: []const []const u8 = v8_trace_node_fields[0..],
    sample_fields: []const []const u8 = v8_sample_fields[0..],
    location_fields: []const []const u8 = v8_location_fields[0..],
};

const V8SnapshotDescription = struct {
    meta: V8Meta = .{},
    node_count: usize,
    edge_count: usize,
    trace_function_count: usize = 0,
};

const V8Snapshot = struct {
    snapshot: V8SnapshotDescription,
    nodes: []const u64,
    edges: []const u64,
    trace_function_infos: []const u64 = &.{},
    trace_tree: []const u64 = &.{},
    samples: []const u64 = &.{},
    locations: []const u64 = &.{},
    strings: []const []const u8,
};

pub fn convertJscToV8(allocator: std.mem.Allocator, source: []const u8) ![]u8 {
    var scratch = std.heap.ArenaAllocator.init(allocator);
    defer scratch.deinit();
    const arena = scratch.allocator();
    const graph = try parseGraph(arena, source);

    var strings: std.ArrayList([]const u8) = .empty;
    var string_indexes: std.StringHashMapUnmanaged(u64) = .empty;
    _ = try internString(arena, &string_indexes, &strings, "");
    var nodes: std.ArrayList(u64) = .empty;
    var edges: std.ArrayList(u64) = .empty;
    try nodes.ensureTotalCapacity(arena, graph.nodes.len * 7);
    try edges.ensureTotalCapacity(arena, graph.outgoing_edges.len * 3);

    for (graph.nodes, 0..) |node, node_index| {
        const class_name = graph.className(node);
        try nodes.appendSlice(arena, &.{
            v8NodeType(class_name, node.flags, node.id),
            try internString(arena, &string_indexes, &strings, class_name),
            node.id,
            node.size,
            graph.outgoing(node_index).len,
            0,
            0,
        });
        for (graph.outgoing(node_index)) |edge_index| {
            const edge = graph.edges[edge_index];
            const edge_type = graph.edgeType(edge);
            const name_or_index = if (std.mem.eql(u8, edge_type, "Index"))
                edge.data_index
            else blk: {
                const name = if (std.mem.eql(u8, edge_type, "Internal")) "" else stringAt(graph.edge_names, std.math.cast(usize, edge.data_index) orelse std.math.maxInt(usize)) orelse "";
                break :blk try internString(arena, &string_indexes, &strings, name);
            };
            try edges.appendSlice(arena, &.{
                v8EdgeType(edge_type),
                name_or_index,
                @as(u64, @intCast(edge.to_index.?)) * 7,
            });
        }
    }

    const output = V8Snapshot{
        .snapshot = .{
            .node_count = graph.nodes.len,
            .edge_count = graph.outgoing_edges.len,
        },
        .nodes = nodes.items,
        .edges = edges.items,
        .strings = strings.items,
    };
    return try std.json.Stringify.valueAlloc(allocator, output, .{});
}

const DfsFrame = struct {
    node_index: usize,
    next_edge: usize = 0,
};

fn calculateRetainedSizes(allocator: std.mem.Allocator, graph: *HeapGraph) !void {
    const node_count = graph.nodes.len;
    if (node_count == 0) return error.EmptyHeapSnapshot;
    var visited = try allocator.alloc(bool, node_count);
    @memset(visited, false);
    const node_to_postorder = try allocator.alloc(usize, node_count);
    const postorder_to_node = try allocator.alloc(usize, node_count);
    var stack: std.ArrayList(DfsFrame) = .empty;
    try stack.append(allocator, .{ .node_index = 0 });
    visited[0] = true;
    var postorder_count: usize = 0;

    while (stack.items.len > 0) {
        const frame = &stack.items[stack.items.len - 1];
        const outgoing = graph.outgoing(frame.node_index);
        var found_child = false;
        while (frame.next_edge < outgoing.len) {
            const edge = graph.edges[outgoing[frame.next_edge]];
            frame.next_edge += 1;
            const child = edge.to_index.?;
            if (visited[child]) continue;
            visited[child] = true;
            try stack.append(allocator, .{ .node_index = child });
            found_child = true;
            break;
        }
        if (found_child) continue;
        const finished = stack.pop().?;
        node_to_postorder[finished.node_index] = postorder_count;
        postorder_to_node[postorder_count] = finished.node_index;
        postorder_count += 1;
    }

    if (postorder_count != node_count) {
        if (postorder_count > 0 and postorder_to_node[postorder_count - 1] == 0) postorder_count -= 1;
        for (1..node_count) |node_index| {
            if (visited[node_index]) continue;
            node_to_postorder[node_index] = postorder_count;
            postorder_to_node[postorder_count] = node_index;
            postorder_count += 1;
        }
        node_to_postorder[0] = postorder_count;
        postorder_to_node[postorder_count] = 0;
        postorder_count += 1;
    }
    if (postorder_count != node_count) return error.InvalidHeapGraph;

    const root_postorder = node_count - 1;
    const no_entry = node_count;
    const affected = try allocator.alloc(bool, node_count);
    @memset(affected, false);
    const dominators = try allocator.alloc(usize, node_count);
    @memset(dominators, no_entry);
    dominators[root_postorder] = root_postorder;

    for (graph.outgoing(0)) |edge_index| {
        const child = graph.edges[edge_index].to_index.?;
        affected[node_to_postorder[child]] = true;
        graph.nodes[child].is_gc_root = true;
    }

    var changed = true;
    while (changed) {
        changed = false;
        var cursor = root_postorder;
        while (cursor > 0) {
            cursor -= 1;
            const postorder = cursor;
            if (!affected[postorder]) continue;
            affected[postorder] = false;
            if (dominators[postorder] == root_postorder) continue;

            const node_index = postorder_to_node[postorder];
            var new_dominator = no_entry;
            for (graph.incoming(node_index)) |edge_index| {
                const parent_index = graph.edges[edge_index].from_index.?;
                const parent_postorder = node_to_postorder[parent_index];
                if (dominators[parent_postorder] == no_entry) continue;
                if (new_dominator == no_entry) {
                    new_dominator = parent_postorder;
                    continue;
                }
                var finger_a = parent_postorder;
                var finger_b = new_dominator;
                var iterations: usize = 0;
                while (finger_a != finger_b and iterations < node_count * 2) : (iterations += 1) {
                    if (finger_a < finger_b) {
                        finger_a = dominators[finger_a];
                    } else {
                        finger_b = dominators[finger_b];
                    }
                    if (finger_a == no_entry or finger_b == no_entry) break;
                }
                if (finger_a == finger_b) new_dominator = finger_a;
                if (new_dominator == root_postorder) break;
            }

            if (new_dominator != no_entry and dominators[postorder] != new_dominator) {
                dominators[postorder] = new_dominator;
                changed = true;
                for (graph.outgoing(node_index)) |edge_index| {
                    const child = graph.edges[edge_index].to_index.?;
                    affected[node_to_postorder[child]] = true;
                }
            }
        }
    }

    for (0..node_count) |postorder| {
        const node_index = postorder_to_node[postorder];
        const dominator_postorder = dominators[postorder];
        graph.nodes[node_index].dominator = if (dominator_postorder < node_count)
            postorder_to_node[dominator_postorder]
        else
            0;
        graph.nodes[node_index].retained_size = graph.nodes[node_index].size;
    }
    for (postorder_to_node[0..root_postorder]) |node_index| {
        const dominator = graph.nodes[node_index].dominator;
        graph.nodes[dominator].retained_size +|= graph.nodes[node_index].retained_size;
    }
}

fn appendEscaped(output: *std.array_list.Managed(u8), value: []const u8, limit: ?usize) !void {
    var end = @min(value.len, limit orelse value.len);
    while (end > 0 and end < value.len and (value[end] & 0xc0) == 0x80) end -= 1;
    for (value[0..end]) |byte| {
        switch (byte) {
            '\n' => try output.appendSlice("\\n"),
            '\r' => try output.appendSlice("\\r"),
            '\t' => try output.appendSlice("\\t"),
            '\\' => try output.appendSlice("\\\\"),
            '"' => try output.appendSlice("\\\""),
            '|' => try output.appendSlice("\\|"),
            '`' => try output.appendSlice("\\`"),
            0...8, 11...12, 14...31, 127 => {},
            else => try output.append(byte),
        }
    }
    if (end < value.len) try output.appendSlice("...");
}

fn appendBytes(output: *std.array_list.Managed(u8), bytes: u64) !void {
    if (bytes < 1024) return output.print("{d} B", .{bytes});
    if (bytes < 1024 * 1024) return output.print("{d}.{d} KB", .{ bytes / 1024, (bytes % 1024) * 10 / 1024 });
    if (bytes < 1024 * 1024 * 1024) return output.print("{d}.{d} MB", .{ bytes / (1024 * 1024), (bytes % (1024 * 1024)) * 10 / (1024 * 1024) });
    return output.print("{d}.{d} GB", .{ bytes / (1024 * 1024 * 1024), (bytes % (1024 * 1024 * 1024)) * 10 / (1024 * 1024 * 1024) });
}

fn appendEdgeName(output: *std.array_list.Managed(u8), graph: HeapGraph, edge: HeapEdge) !bool {
    const edge_type = graph.edgeType(edge);
    if (std.mem.eql(u8, edge_type, "Index")) {
        try output.print("[{d}]", .{edge.data_index});
        return true;
    }
    const name = graph.edgeName(edge);
    if (name.len == 0) return false;
    try appendEscaped(output, name, null);
    return true;
}

fn edgeHasName(graph: HeapGraph, edge: HeapEdge) bool {
    return std.mem.eql(u8, graph.edgeType(edge), "Index") or graph.edgeName(edge).len > 0;
}

fn typeStatsLessThan(_: void, left: TypeStats, right: TypeStats) bool {
    if (left.total_retained_size != right.total_retained_size) return left.total_retained_size > right.total_retained_size;
    return std.mem.lessThan(u8, left.name, right.name);
}

fn objectRetainedLessThan(nodes: []const HeapNode, left: usize, right: usize) bool {
    if (nodes[left].retained_size != nodes[right].retained_size) return nodes[left].retained_size > nodes[right].retained_size;
    return nodes[left].id < nodes[right].id;
}

pub fn buildMarkdown(allocator: std.mem.Allocator, source: []const u8) ![]u8 {
    var scratch = std.heap.ArenaAllocator.init(allocator);
    defer scratch.deinit();
    const arena = scratch.allocator();
    var graph = try parseGraph(arena, source);
    try calculateRetainedSizes(arena, &graph);

    var total_heap_size: u64 = 0;
    var gc_root_count: usize = 0;
    var type_indexes: std.StringHashMapUnmanaged(usize) = .empty;
    var type_stats: std.ArrayList(TypeStats) = .empty;
    for (graph.nodes) |node| {
        total_heap_size +|= node.size;
        if (node.is_gc_root) gc_root_count += 1;
        const name = graph.className(node);
        const result = try type_indexes.getOrPut(arena, name);
        if (!result.found_existing) {
            result.value_ptr.* = type_stats.items.len;
            try type_stats.append(arena, .{ .name = name });
        }
        const stats = &type_stats.items[result.value_ptr.*];
        stats.total_size +|= node.size;
        stats.total_retained_size +|= node.retained_size;
        stats.count += 1;
        if (node.retained_size > stats.largest_retained) {
            stats.largest_retained = node.retained_size;
            stats.largest_instance_id = node.id;
        }
    }
    std.mem.sort(TypeStats, type_stats.items, {}, typeStatsLessThan);

    const largest_objects = try arena.alloc(usize, graph.nodes.len);
    for (largest_objects, 0..) |*item, index| item.* = index;
    std.mem.sort(usize, largest_objects, graph.nodes, objectRetainedLessThan);

    var output = std.array_list.Managed(u8).init(allocator);
    errdefer output.deinit();
    const estimated_output_size = std.math.mul(usize, source.len, 3) catch source.len;
    try output.ensureTotalCapacity(estimated_output_size);
    try output.appendSlice(
        "# Bun Heap Profile\n\n" ++
            "Generated by `bun --heap-prof-md`. This profile contains complete heap data in markdown format.\n\n" ++
            "**Quick Search Commands:**\n```bash\n" ++
            "grep '| `Function`' file.md            # Find all Function objects\n" ++
            "grep 'gcroot=1' file.md               # Find all GC roots\n" ++
            "grep '| 12345 |' file.md              # Find object #12345 or edges involving it\n" ++
            "```\n\n---\n\n" ++
            "## Summary\n\n| Metric | Value |\n|--------|------:|\n| Total Heap Size | ",
    );
    try appendBytes(&output, total_heap_size);
    try output.print(
        " ({d} bytes) |\n| Total Objects | {d} |\n| Total Edges | {d} |\n| Unique Types | {d} |\n| GC Roots | {d} |\n\n",
        .{ total_heap_size, graph.nodes.len, graph.edges.len, type_stats.items.len, gc_root_count },
    );

    try output.appendSlice("## Top 50 Types by Retained Size\n\n| Rank | Type | Count | Self Size | Retained Size | Largest Instance |\n|-----:|------|------:|----------:|--------------:|-----------------:|\n");
    for (type_stats.items[0..@min(50, type_stats.items.len)], 1..) |stats, rank| {
        try output.print("| {d} | `", .{rank});
        try appendEscaped(&output, stats.name, null);
        try output.print("` | {d} | ", .{stats.count});
        try appendBytes(&output, stats.total_size);
        try output.appendSlice(" | ");
        try appendBytes(&output, stats.total_retained_size);
        try output.appendSlice(" | ");
        try appendBytes(&output, stats.largest_retained);
        try output.appendSlice(" |\n");
    }

    try output.appendSlice("\n## Top 50 Largest Objects\n\nObjects that retain the most memory (potential memory leak sources):\n\n| Rank | ID | Type | Self Size | Retained Size | Out-Edges | In-Edges |\n|-----:|---:|------|----------:|--------------:|----------:|---------:|\n");
    for (largest_objects[0..@min(50, largest_objects.len)], 1..) |node_index, rank| {
        const node = graph.nodes[node_index];
        try output.print("| {d} | {d} | `", .{ rank, node.id });
        try appendEscaped(&output, graph.className(node), null);
        try output.appendSlice("` | ");
        try appendBytes(&output, node.size);
        try output.appendSlice(" | ");
        try appendBytes(&output, node.retained_size);
        try output.print(" | {d} | {d} |\n", .{ graph.outgoing(node_index).len, graph.incoming(node_index).len });
    }

    try output.appendSlice("\n## Retainer Chains\n\nHow the top 20 largest objects are kept alive (path from GC root to object):\n\n");
    const no_index = std.math.maxInt(usize);
    const visited = try arena.alloc(bool, graph.nodes.len);
    const child = try arena.alloc(usize, graph.nodes.len);
    const child_edge = try arena.alloc(usize, graph.nodes.len);
    const queue = try arena.alloc(usize, graph.nodes.len);
    for (largest_objects[0..@min(20, largest_objects.len)], 1..) |target, rank| {
        @memset(visited, false);
        @memset(child, no_index);
        @memset(child_edge, no_index);
        var queue_start: usize = 0;
        var queue_end: usize = 1;
        queue[0] = target;
        visited[target] = true;
        var found_root: ?usize = if (graph.nodes[target].is_gc_root) target else null;
        while (queue_start < queue_end and found_root == null) {
            const current = queue[queue_start];
            queue_start += 1;
            for (graph.incoming(current)) |edge_index| {
                const retainer = graph.edges[edge_index].from_index.?;
                if (visited[retainer]) continue;
                visited[retainer] = true;
                child[retainer] = current;
                child_edge[retainer] = edge_index;
                queue[queue_end] = retainer;
                queue_end += 1;
                if (graph.nodes[retainer].is_gc_root) {
                    found_root = retainer;
                    break;
                }
            }
        }

        const node = graph.nodes[target];
        try output.print("### {d}. Object #{d} - `", .{ rank, node.id });
        try appendEscaped(&output, graph.className(node), null);
        try output.appendSlice("` (");
        try appendBytes(&output, node.retained_size);
        try output.appendSlice(" retained)\n\n```\n");
        if (found_root) |root| {
            var current = root;
            var depth: usize = 0;
            while (true) {
                for (0..depth) |_| try output.appendSlice("    ");
                const path_node = graph.nodes[current];
                try appendEscaped(&output, graph.className(path_node), null);
                try output.print("#{d}", .{path_node.id});
                if (path_node.is_gc_root) try output.appendSlice(" [ROOT]");
                try output.appendSlice(" (");
                try appendBytes(&output, path_node.size);
                try output.appendSlice(")");
                if (current == target or child[current] == no_index) {
                    try output.append('\n');
                    break;
                }
                const edge = graph.edges[child_edge[current]];
                if (edgeHasName(graph, edge)) {
                    try output.appendSlice(" .");
                    _ = try appendEdgeName(&output, graph, edge);
                }
                try output.appendSlice(" ->\n");
                current = child[current];
                depth += 1;
            }
        } else {
            try output.appendSlice("(no path to GC root found)\n");
        }
        try output.appendSlice("```\n\n");
    }

    try output.appendSlice("## GC Roots\n\nObjects directly held by the runtime (prevent garbage collection):\n\n| ID | Type | Size | Retained | Label |\n|---:|------|-----:|---------:|-------|\n");
    var displayed_roots: usize = 0;
    for (graph.nodes) |node| {
        if (!node.is_gc_root or displayed_roots >= 100) continue;
        try output.print("| {d} | `", .{node.id});
        try appendEscaped(&output, graph.className(node), null);
        try output.appendSlice("` | ");
        try appendBytes(&output, node.size);
        try output.appendSlice(" | ");
        try appendBytes(&output, node.retained_size);
        try output.appendSlice(" | ");
        try appendEscaped(&output, graph.label(node), 50);
        try output.appendSlice(" |\n");
        displayed_roots += 1;
    }
    if (gc_root_count > displayed_roots) try output.print("\n*... and {d} more GC roots*\n", .{gc_root_count - displayed_roots});

    try output.print("\n## All Objects\n\n<details>\n<summary>Click to expand {d} objects (searchable with grep)</summary>\n\n| ID | Type | Size | Retained | Flags | Label |\n|---:|------|-----:|---------:|-------|-------|\n", .{graph.nodes.len});
    for (graph.nodes) |node| {
        try output.print("| {d} | `", .{node.id});
        try appendEscaped(&output, graph.className(node), null);
        try output.print("` | {d} | {d} | ", .{ node.size, node.retained_size });
        if (node.is_gc_root) try output.appendSlice("gcroot=1 ");
        if ((node.flags & 1) != 0) try output.appendSlice("internal=1");
        try output.appendSlice(" | ");
        try appendEscaped(&output, graph.label(node), 40);
        try output.appendSlice(" |\n");
    }
    try output.appendSlice("\n</details>\n\n");

    try output.print("## All Edges\n\n<details>\n<summary>Click to expand {d} edges (object reference graph)</summary>\n\n| From | To | Type | Name |\n|-----:|---:|------|------|\n", .{graph.edges.len});
    for (graph.edges) |edge| {
        try output.print("| {d} | {d} | ", .{ edge.from_id, edge.to_id });
        try appendEscaped(&output, graph.edgeType(edge), null);
        try output.appendSlice(" | ");
        _ = try appendEdgeName(&output, graph, edge);
        try output.appendSlice(" |\n");
    }
    try output.appendSlice("\n</details>\n\n");

    try output.appendSlice("## String Values\n\nString objects (useful for identifying leak sources by content):\n\n<details>\n<summary>Click to expand string values</summary>\n\n| ID | Size | Value |\n|---:|-----:|-------|\n");
    for (graph.nodes) |node| {
        const name = graph.className(node);
        if (!std.ascii.eqlIgnoreCase(name, "string")) continue;
        try output.print("| {d} | {d} | `", .{ node.id, node.size });
        try appendEscaped(&output, graph.label(node), 100);
        try output.appendSlice("` |\n");
    }
    try output.appendSlice("\n</details>\n\n");

    try output.print("## Complete Type Statistics\n\n<details>\n<summary>Click to expand all {d} types</summary>\n\n| Type | Count | Self Size | Retained Size | Largest ID |\n|------|------:|----------:|--------------:|-----------:|\n", .{type_stats.items.len});
    for (type_stats.items) |stats| {
        try output.appendSlice("| `");
        try appendEscaped(&output, stats.name, null);
        try output.print("` | {d} | {d} | {d} | {d} |\n", .{ stats.count, stats.total_size, stats.total_retained_size, stats.largest_instance_id });
    }
    try output.appendSlice("\n</details>\n\n");

    try output.print("## Property Names\n\n<details>\n<summary>Click to expand all {d} property/variable names</summary>\n\n| Index | Name |\n|------:|------|\n", .{graph.edge_names.len});
    for (graph.edge_names, 0..) |name, index| {
        if (name.len == 0) continue;
        try output.print("| {d} | `", .{index});
        try appendEscaped(&output, name, null);
        try output.appendSlice("` |\n");
    }
    try output.appendSlice("\n</details>\n\n---\n\n*End of heap profile*\n");
    return try output.toOwnedSlice();
}

test "converts JSC inspector snapshots to V8 format" {
    const source =
        \\{"type":"Inspector","nodes":[0,0,0,0,1,16,1,0,2,8,2,0],"nodeClassNames":["<root>","Object","string"],"edges":[0,1,0,0,1,2,2,0],"edgeTypes":["Property","Internal","Index"],"edgeNames":["child"],"roots":[0,0,0]}
    ;
    const output = try convertJscToV8(std.testing.allocator, source);
    defer std.testing.allocator.free(output);
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, output, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, 3), parsed.value.object.get("snapshot").?.object.get("node_count").?.integer);
    try std.testing.expectEqual(@as(usize, 21), parsed.value.object.get("nodes").?.array.items.len);
    try std.testing.expectEqual(@as(usize, 6), parsed.value.object.get("edges").?.array.items.len);
}

test "decodes escaped snapshot strings" {
    var scratch = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer scratch.deinit();
    const decoded = try decodeJsonString(scratch.allocator(), "Obj\\u0065ct\\n\\ud83c\\udf0d");
    try std.testing.expect(std.mem.eql(u8, decoded, "Object\n\xf0\x9f\x8c\x8d"));
}

test "builds markdown from JSC GC debugging snapshots" {
    const source =
        \\{"type":"GCDebugging","nodes":[0,0,0,1,0,0,0,1,32,1,0,1,0,0],"nodeClassNames":["<root>","Payload"],"edges":[0,1,0,0],"edgeTypes":["Property"],"edgeNames":["payload"],"labels":["root","value"],"roots":[0,0,0]}
    ;
    const output = try buildMarkdown(std.testing.allocator, source);
    defer std.testing.allocator.free(output);
    try std.testing.expect(std.mem.indexOf(u8, output, "# Bun Heap Profile") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "| Total Objects | 2 |") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "## Retainer Chains") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "`Payload`") != null);
}
