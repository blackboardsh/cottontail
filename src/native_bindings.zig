const filesystem = @import("native_bindings/host/filesystem.zig");
const memory = @import("native_bindings/host/memory.zig");
const process = @import("native_bindings/host/process.zig");
const tooling = @import("native_bindings/host/tooling.zig");

pub fn forceLink() void {
    memory.forceLink();
    filesystem.forceLink();
    process.forceLink();
    tooling.forceLink();
}
