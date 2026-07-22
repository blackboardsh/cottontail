const host = @import("../../host.zig");

pub fn forceLink() void {
    _ = &host.ct_host_exists;
    _ = &host.ct_host_mkdir;
    _ = &host.ct_host_rm;
    _ = &host.ct_host_rmdir;
    _ = &host.ct_host_unlink;
    _ = &host.ct_host_chmod;
}
