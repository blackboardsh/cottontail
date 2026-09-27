const markdown = @import("native_markdown");

comptime {
    _ = &markdown.ct_markdown_render_html;
    _ = &markdown.ct_markdown_parse_events;
    _ = &markdown.ct_markdown_free;
    _ = &markdown.ct_markdown_string_free;
}
// When this file is a capability DLL root on Windows, leave the entry point to
// msvcrt.lib instead of std.start, so the MSVC CRT initializes this module (see
// scripts/verify-windows-capability-dlls.js). No effect on other targets.
pub const _DllMainCRTStartup = {};
