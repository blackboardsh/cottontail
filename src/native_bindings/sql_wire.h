#ifndef COTTONTAIL_SQL_WIRE_H
#define COTTONTAIL_SQL_WIRE_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    size_t offset;
    size_t len;
    uint8_t is_null;
} CtSqlWireSlice;

typedef struct {
    uint8_t kind;
    uint8_t sequence_id;
    size_t payload_offset;
    size_t payload_len;
} CtSqlWireFrame;

typedef struct {
    CtSqlWireSlice name;
    uint32_t table_oid;
    uint16_t attribute;
    uint32_t type_oid;
    int16_t type_size;
    int32_t type_modifier;
    uint16_t format;
} CtSqlPostgresColumn;

typedef struct {
    uint32_t oid;
    uint32_t flags;
    const uint8_t *bytes;
    size_t len;
} CtSqlPostgresParameter;

typedef struct {
    CtSqlWireSlice catalog;
    CtSqlWireSlice schema;
    CtSqlWireSlice table;
    CtSqlWireSlice original_table;
    CtSqlWireSlice name;
    CtSqlWireSlice original_name;
    uint16_t character_set;
    uint32_t column_length;
    uint8_t field_type;
    uint16_t flags;
    uint8_t decimals;
} CtSqlMySQLColumn;

enum {
    CT_SQL_POSTGRES_PARAMETER_NULL = 1u << 0,
    CT_SQL_POSTGRES_PARAMETER_BYTEA = 1u << 1,
};

int ct_sql_postgres_frame_messages(
    const uint8_t *input,
    size_t input_len,
    CtSqlWireFrame **frames_out,
    size_t *frame_count_out,
    size_t *consumed_out,
    char **error_out
);

int ct_sql_mysql_frame_packets(
    const uint8_t *input,
    size_t input_len,
    CtSqlWireFrame **frames_out,
    size_t *frame_count_out,
    size_t *consumed_out,
    char **error_out
);

int ct_sql_postgres_decode_row_description(
    const uint8_t *input,
    size_t input_len,
    CtSqlPostgresColumn **columns_out,
    size_t *column_count_out,
    char **error_out
);

int ct_sql_postgres_decode_data_row(
    const uint8_t *input,
    size_t input_len,
    CtSqlWireSlice **fields_out,
    size_t *field_count_out,
    char **error_out
);

int ct_sql_postgres_build_extended_query(
    const uint8_t *statement,
    size_t statement_len,
    const CtSqlPostgresParameter *parameters,
    size_t parameter_count,
    uint8_t **output_out,
    size_t *output_len_out,
    char **error_out
);

int ct_sql_mysql_read_length_encoded_integer(
    const uint8_t *input,
    size_t input_len,
    size_t initial_offset,
    uint64_t *value_out,
    size_t *next_offset_out,
    uint8_t *is_null_out,
    char **error_out
);

int ct_sql_mysql_decode_column(
    const uint8_t *input,
    size_t input_len,
    CtSqlMySQLColumn *column_out,
    char **error_out
);

int ct_sql_mysql_decode_row(
    const uint8_t *input,
    size_t input_len,
    size_t expected_field_count,
    CtSqlWireSlice **fields_out,
    size_t *field_count_out,
    char **error_out
);

int ct_sql_mysql_frame_payload(
    const uint8_t *input,
    size_t input_len,
    uint8_t initial_sequence_id,
    uint8_t **output_out,
    size_t *output_len_out,
    uint8_t *next_sequence_id_out,
    char **error_out
);

void ct_sql_wire_free(void *pointer);

#endif
