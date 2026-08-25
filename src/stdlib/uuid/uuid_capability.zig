const uuid = @import("native_uuid");

comptime {
    _ = &uuid.ct_uuid_v7;
    _ = &uuid.ct_uuid_v5;
    _ = &uuid.ct_uuid_v5_utf16;
    _ = &uuid.ct_uuid_format;
}
