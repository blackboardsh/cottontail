const password = @import("password_native");

comptime {
    _ = &password.ct_password_hash;
    _ = &password.ct_password_verify;
}
// When this file is a capability DLL root on Windows, leave the entry point to
// msvcrt.lib instead of std.start, so the MSVC CRT initializes this module (see
// scripts/verify-windows-capability-dlls.js). No effect on other targets.
pub const _DllMainCRTStartup = {};
