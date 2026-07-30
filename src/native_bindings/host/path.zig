const native_path = @import("../../native_path.zig");

pub fn forceLink() void {
    _ = &native_path.ct_path_core_normalize;
    _ = &native_path.ct_path_core_free;
}
