const host = @import("../../host.zig");

pub fn forceLink() void {
    _ = &host.ct_host_exists;
    _ = &host.ct_host_mime_type_by_extension;
    _ = &host.ct_host_walk_dir;
    _ = &host.ct_host_mkdir;
    _ = &host.ct_host_rm;
    _ = &host.ct_host_rmdir;
    _ = &host.ct_host_unlink;
    _ = &host.ct_host_chmod;
}
