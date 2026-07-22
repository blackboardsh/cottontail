const host = @import("../../host.zig");

pub fn forceLink() void {
    _ = &host.ct_host_string_free;
    _ = &host.ct_host_buffer_free;
}
