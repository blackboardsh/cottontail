const buffer = @import("native_bindings/host/buffer.zig");
const data_parser = @import("native_bindings/host/data_parser.zig");
const filesystem = @import("native_bindings/host/filesystem.zig");
const memory = @import("native_bindings/host/memory.zig");
const process = @import("native_bindings/host/process.zig");
const sql_wire = @import("native_bindings/host/sql_wire.zig");
const tooling = @import("native_bindings/host/tooling.zig");

pub fn forceLink() void {
    buffer.forceLink();
    data_parser.forceLink();
    memory.forceLink();
    filesystem.forceLink();
    process.forceLink();
    sql_wire.forceLink();
    tooling.forceLink();
}
