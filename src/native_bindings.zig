const filesystem = @import("native_bindings/host/filesystem.zig");
const memory = @import("native_bindings/host/memory.zig");
const process = @import("native_bindings/host/process.zig");
const sql_wire = @import("native_bindings/host/sql_wire.zig");
const tooling = @import("native_bindings/host/tooling.zig");

pub fn forceLink() void {
    memory.forceLink();
    filesystem.forceLink();
    process.forceLink();
    sql_wire.forceLink();
    tooling.forceLink();
}
