const markdown = @import("native_markdown");

comptime {
    _ = &markdown.ct_markdown_render_html;
    _ = &markdown.ct_markdown_parse_events;
    _ = &markdown.ct_markdown_free;
    _ = &markdown.ct_markdown_string_free;
}
