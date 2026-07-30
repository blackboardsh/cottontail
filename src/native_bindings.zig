const buffer = @import("native_bindings/host/buffer.zig");
const data_parser = @import("native_bindings/host/data_parser.zig");
const filesystem = @import("native_bindings/host/filesystem.zig");
const glob = @import("native_bindings/host/glob.zig");
const memory = @import("native_bindings/host/memory.zig");
const path = @import("native_bindings/host/path.zig");
const process = @import("native_bindings/host/process.zig");
const sql_wire = @import("native_bindings/host/sql_wire.zig");
const text_encoding = @import("native_bindings/host/text_encoding.zig");
const tooling = @import("native_bindings/host/tooling.zig");
const uuid = @import("native_bindings/host/uuid.zig");
const websocket_frame = @import("native_bindings/host/websocket_frame.zig");

pub fn forceLink() void {
    buffer.forceLink();
    data_parser.forceLink();
    memory.forceLink();
    path.forceLink();
    filesystem.forceLink();
    glob.forceLink();
    process.forceLink();
    sql_wire.forceLink();
    text_encoding.forceLink();
    tooling.forceLink();
    uuid.forceLink();
    websocket_frame.forceLink();
}
