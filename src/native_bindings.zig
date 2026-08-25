const buffer = @import("native_bindings/host/buffer.zig");
const filesystem = @import("native_bindings/host/filesystem.zig");
const memory = @import("native_bindings/host/memory.zig");
const path = @import("native_bindings/host/path.zig");
const process = @import("native_bindings/host/process.zig");
const text_encoding = @import("native_bindings/host/text_encoding.zig");
const tooling = @import("native_bindings/host/tooling.zig");

pub fn forceLink() void {
    buffer.forceLink();
    memory.forceLink();
    path.forceLink();
    filesystem.forceLink();
    process.forceLink();
    text_encoding.forceLink();
    tooling.forceLink();
}
