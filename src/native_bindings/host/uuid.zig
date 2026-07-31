const native_uuid = @import("../../native_uuid.zig");

pub fn forceLink() void {
    _ = &native_uuid.ct_uuid_v7;
    _ = &native_uuid.ct_uuid_v5;
    _ = &native_uuid.ct_uuid_v5_utf16;
    _ = &native_uuid.ct_uuid_v5_latin1;
    _ = &native_uuid.ct_uuid_format;
}
