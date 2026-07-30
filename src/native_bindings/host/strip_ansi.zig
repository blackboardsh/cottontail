const native_strip_ansi = @import("../../native_strip_ansi.zig");

pub fn forceLink() void {
    _ = &native_strip_ansi.ct_strip_ansi_core;
    _ = &native_strip_ansi.ct_strip_ansi_core_free;
}
