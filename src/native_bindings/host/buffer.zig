const buffer_ops = @import("../../buffer_ops.zig");

pub fn forceLink() void {
    _ = &buffer_ops.ct_buffer_compare;
    _ = &buffer_ops.ct_buffer_index_of;
    _ = &buffer_ops.ct_buffer_index_of_line;
    _ = &buffer_ops.ct_buffer_fill_pattern;
}
