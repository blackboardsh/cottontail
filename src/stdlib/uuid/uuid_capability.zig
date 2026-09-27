const uuid = @import("native_uuid");

comptime {
    _ = &uuid.ct_uuid_v7;
    _ = &uuid.ct_uuid_v5;
    _ = &uuid.ct_uuid_v5_utf16;
    _ = &uuid.ct_uuid_format;
}
// When this file is a capability DLL root on Windows, leave the entry point to
// msvcrt.lib instead of std.start, so the MSVC CRT initializes this module (see
// scripts/verify-windows-capability-dlls.js). No effect on other targets.
pub const _DllMainCRTStartup = {};
