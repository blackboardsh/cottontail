const sql_wire = @import("../../sql_wire.zig");

pub fn forceLink() void {
    _ = &sql_wire.ct_sql_postgres_frame_messages;
    _ = &sql_wire.ct_sql_mysql_frame_packets;
    _ = &sql_wire.ct_sql_postgres_decode_row_description;
    _ = &sql_wire.ct_sql_postgres_decode_data_row;
    _ = &sql_wire.ct_sql_postgres_build_extended_query;
    _ = &sql_wire.ct_sql_mysql_read_length_encoded_integer;
    _ = &sql_wire.ct_sql_mysql_decode_column;
    _ = &sql_wire.ct_sql_mysql_decode_row;
    _ = &sql_wire.ct_sql_mysql_frame_payload;
    _ = &sql_wire.ct_sql_wire_free;
}
