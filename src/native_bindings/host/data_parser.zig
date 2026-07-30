const data_parser = @import("../../data_parser.zig");

pub fn forceLink() void {
    _ = &data_parser.ct_yaml_parser_parse;
}
