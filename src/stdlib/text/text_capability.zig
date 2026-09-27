const string_width = @import("string_width");
const strip_ansi = @import("strip_ansi");

comptime {
    _ = &string_width.ct_string_width_utf16;
    _ = &strip_ansi.ct_strip_ansi_utf16;
    _ = &strip_ansi.ct_strip_ansi_free_utf16;
}
// When this file is a capability DLL root on Windows, leave the entry point to
// msvcrt.lib instead of std.start, so the MSVC CRT initializes this module (see
// scripts/verify-windows-capability-dlls.js). No effect on other targets.
pub const _DllMainCRTStartup = {};
