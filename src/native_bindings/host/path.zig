const native_path = @import("../../native_path.zig");
const native_which = @import("../../native_which.zig");
const host = @import("../../host.zig");

pub export fn ct_which_core_find_on_path(
    path_value: native_which.Slice,
    cwd_value: native_which.Slice,
    bin_value: native_which.Slice,
    system_root_value: native_which.Slice,
    canonical_system_root_value: native_which.Slice,
    output: *native_which.Result,
) c_int {
    return native_which.findOnPathWithIo(
        host.getIo(),
        path_value,
        cwd_value,
        bin_value,
        system_root_value,
        canonical_system_root_value,
        output,
    );
}

pub export fn ct_which_core_free(pointer: ?*anyopaque, len: usize) void {
    native_which.freeResult(pointer, len);
}

pub fn forceLink() void {
    _ = &native_path.ct_path_core_normalize;
    _ = &native_path.ct_path_core_free;
    _ = &ct_which_core_find_on_path;
    _ = &ct_which_core_free;
}
