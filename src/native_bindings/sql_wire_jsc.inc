#include "sql_wire.h"

static void ct_sql_wire_array_buffer_free(void *bytes, void *context) {
    (void)context;
    ct_sql_wire_free(bytes);
}

static void ct_sql_wire_throw(JSContextRef context, JSValueRef *exception, char *error, const char *fallback) {
    ct_throw_message(context, exception, error != NULL ? error : fallback);
    ct_sql_wire_free(error);
}

static bool ct_sql_wire_input(
    JSContextRef context,
    JSValueRef value,
    uint8_t **bytes_out,
    size_t *len_out,
    JSValueRef *exception,
    const char *message
) {
    if (ct_get_bytes(context, value, bytes_out, len_out) == 0) return true;
    ct_throw_type_error(context, exception, message);
    return false;
}

static JSValueRef ct_sql_wire_owned_buffer(
    JSContextRef context,
    uint8_t **bytes,
    size_t len,
    JSValueRef *exception
) {
    JSObjectRef result = JSObjectMakeArrayBufferWithBytesNoCopy(
        context,
        *bytes,
        len,
        ct_sql_wire_array_buffer_free,
        NULL,
        exception
    );
    if (result != NULL) {
        *bytes = NULL;
        return result;
    }
    ct_sql_wire_free(*bytes);
    *bytes = NULL;
    return JSValueMakeUndefined(context);
}

static JSValueRef ct_sql_wire_slice_buffer(
    JSContextRef context,
    const uint8_t *input,
    size_t input_len,
    CtSqlWireSlice slice,
    JSValueRef *exception
) {
    if (slice.is_null != 0) return JSValueMakeNull(context);
    if (slice.offset > input_len || slice.len > input_len - slice.offset) {
        ct_throw_message(context, exception, "Native SQL codec returned an invalid byte slice");
        return JSValueMakeUndefined(context);
    }
    return ct_array_buffer_from_copy(
        context,
        (const char *)(input + slice.offset),
        slice.len,
        exception
    );
}

static JSValueRef ct_sql_wire_slice_string(
    JSContextRef context,
    const uint8_t *input,
    size_t input_len,
    CtSqlWireSlice slice,
    JSValueRef *exception
) {
    if (slice.is_null != 0) return ct_make_string(context, "");
    if (slice.offset > input_len || slice.len > input_len - slice.offset) {
        ct_throw_message(context, exception, "Native SQL codec returned an invalid string slice");
        return JSValueMakeUndefined(context);
    }
    return ct_make_string_len(context, (const char *)(input + slice.offset), slice.len);
}

static JSValueRef ct_sql_postgres_frame_messages_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlPostgresFrameMessages(buffer) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "PostgreSQL wire input must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }

    CtSqlWireFrame *frames = NULL;
    size_t frame_count = 0;
    size_t consumed = 0;
    char *error = NULL;
    if (ct_sql_postgres_frame_messages(
            input,
            input_len,
            &frames,
            &frame_count,
            &consumed,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "PostgreSQL message framing failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef messages = ct_make_array(context, 0, NULL, exception);
    for (size_t index = 0; index < frame_count && (exception == NULL || *exception == NULL); index += 1) {
        const CtSqlWireFrame frame = frames[index];
        if (frame.payload_offset > input_len || frame.payload_len > input_len - frame.payload_offset) {
            ct_throw_message(context, exception, "Native SQL codec returned an invalid PostgreSQL frame");
            break;
        }
        char type[2] = { (char)frame.kind, '\0' };
        JSObjectRef message = ct_make_object(context);
        ct_set_property(context, message, "type", ct_make_string(context, type), exception);
        ct_set_property(
            context,
            message,
            "body",
            ct_array_buffer_from_copy(
                context,
                (const char *)(input + frame.payload_offset),
                frame.payload_len,
                exception
            ),
            exception
        );
        JSObjectSetPropertyAtIndex(context, messages, (unsigned)index, message, exception);
    }
    ct_sql_wire_free(frames);
    if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(context);

    JSObjectRef result = ct_make_object(context);
    ct_set_property(context, result, "consumed", JSValueMakeNumber(context, (double)consumed), exception);
    ct_set_property(context, result, "messages", messages, exception);
    return result;
}

static JSValueRef ct_sql_mysql_frame_packets_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlMysqlFramePackets(buffer) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "MySQL wire input must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }

    CtSqlWireFrame *frames = NULL;
    size_t frame_count = 0;
    size_t consumed = 0;
    char *error = NULL;
    if (ct_sql_mysql_frame_packets(
            input,
            input_len,
            &frames,
            &frame_count,
            &consumed,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "MySQL packet framing failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef packets = ct_make_array(context, 0, NULL, exception);
    for (size_t index = 0; index < frame_count && (exception == NULL || *exception == NULL); index += 1) {
        const CtSqlWireFrame frame = frames[index];
        if (frame.payload_offset > input_len || frame.payload_len > input_len - frame.payload_offset) {
            ct_throw_message(context, exception, "Native SQL codec returned an invalid MySQL frame");
            break;
        }
        JSObjectRef packet = ct_make_object(context);
        ct_set_property(
            context,
            packet,
            "sequenceId",
            JSValueMakeNumber(context, (double)frame.sequence_id),
            exception
        );
        ct_set_property(
            context,
            packet,
            "payload",
            ct_array_buffer_from_copy(
                context,
                (const char *)(input + frame.payload_offset),
                frame.payload_len,
                exception
            ),
            exception
        );
        JSObjectSetPropertyAtIndex(context, packets, (unsigned)index, packet, exception);
    }
    ct_sql_wire_free(frames);
    if (exception != NULL && *exception != NULL) return JSValueMakeUndefined(context);

    JSObjectRef result = ct_make_object(context);
    ct_set_property(context, result, "consumed", JSValueMakeNumber(context, (double)consumed), exception);
    ct_set_property(context, result, "packets", packets, exception);
    return result;
}

static JSValueRef ct_sql_postgres_decode_row_description_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlPostgresDecodeRowDescription(buffer) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "PostgreSQL row description must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }

    CtSqlPostgresColumn *columns = NULL;
    size_t column_count = 0;
    char *error = NULL;
    if (ct_sql_postgres_decode_row_description(
            input,
            input_len,
            &columns,
            &column_count,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "PostgreSQL row-description decoding failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef result = ct_make_array(context, 0, NULL, exception);
    for (size_t index = 0; index < column_count && (exception == NULL || *exception == NULL); index += 1) {
        const CtSqlPostgresColumn column = columns[index];
        JSObjectRef value = ct_make_object(context);
        ct_set_property(
            context,
            value,
            "name",
            ct_sql_wire_slice_string(context, input, input_len, column.name, exception),
            exception
        );
        ct_set_property(context, value, "tableOID", JSValueMakeNumber(context, column.table_oid), exception);
        ct_set_property(context, value, "attribute", JSValueMakeNumber(context, column.attribute), exception);
        ct_set_property(context, value, "typeOID", JSValueMakeNumber(context, column.type_oid), exception);
        ct_set_property(context, value, "typeSize", JSValueMakeNumber(context, column.type_size), exception);
        ct_set_property(context, value, "typeModifier", JSValueMakeNumber(context, column.type_modifier), exception);
        ct_set_property(context, value, "format", JSValueMakeNumber(context, column.format), exception);
        JSObjectSetPropertyAtIndex(context, result, (unsigned)index, value, exception);
    }
    ct_sql_wire_free(columns);
    return exception != NULL && *exception != NULL ? JSValueMakeUndefined(context) : result;
}

static JSValueRef ct_sql_postgres_decode_data_row_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlPostgresDecodeDataRow(buffer) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "PostgreSQL data row must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }

    CtSqlWireSlice *fields = NULL;
    size_t field_count = 0;
    char *error = NULL;
    if (ct_sql_postgres_decode_data_row(
            input,
            input_len,
            &fields,
            &field_count,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "PostgreSQL data-row decoding failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef result = ct_make_array(context, 0, NULL, exception);
    for (size_t index = 0; index < field_count && (exception == NULL || *exception == NULL); index += 1) {
        JSObjectSetPropertyAtIndex(
            context,
            result,
            (unsigned)index,
            ct_sql_wire_slice_buffer(context, input, input_len, fields[index], exception),
            exception
        );
    }
    ct_sql_wire_free(fields);
    return exception != NULL && *exception != NULL ? JSValueMakeUndefined(context) : result;
}

static JSValueRef ct_sql_postgres_build_extended_query_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 2 || !JSValueIsObject(context, arguments[1])) {
        ct_throw_type_error(
            context,
            exception,
            "sqlPostgresBuildExtendedQuery(statement, parameters) requires a statement and parameter array"
        );
        return JSValueMakeUndefined(context);
    }

    size_t statement_len = 0;
    char *statement = ct_value_to_utf8_copy_checked(context, arguments[0], &statement_len, exception);
    if (statement == NULL) {
        if (exception == NULL || *exception == NULL) ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef parameter_array = (JSObjectRef)arguments[1];
    JSValueRef length_value = ct_get_property(context, parameter_array, "length", exception);
    if (exception != NULL && *exception != NULL) {
        free(statement);
        return JSValueMakeUndefined(context);
    }
    const double length_number = JSValueToNumber(context, length_value, exception);
    if ((exception != NULL && *exception != NULL) ||
        !isfinite(length_number) ||
        length_number < 0 ||
        length_number > UINT16_MAX ||
        floor(length_number) != length_number) {
        free(statement);
        if (exception == NULL || *exception == NULL) {
            ct_throw_message(context, exception, "PostgreSQL supports at most 65535 query parameters");
        }
        return JSValueMakeUndefined(context);
    }
    const size_t parameter_count = (size_t)length_number;
    CtSqlPostgresParameter *parameters = parameter_count == 0
        ? NULL
        : (CtSqlPostgresParameter *)calloc(parameter_count, sizeof(CtSqlPostgresParameter));
    if (parameter_count > 0 && parameters == NULL) {
        free(statement);
        ct_throw_message(context, exception, "Out of memory");
        return JSValueMakeUndefined(context);
    }

    bool valid = true;
    for (size_t index = 0; index < parameter_count; index += 1) {
        JSValueRef entry_value = JSObjectGetPropertyAtIndex(context, parameter_array, (unsigned)index, exception);
        if ((exception != NULL && *exception != NULL) || !JSValueIsObject(context, entry_value)) {
            if (exception == NULL || *exception == NULL) {
                ct_throw_type_error(context, exception, "Invalid normalized PostgreSQL parameter");
            }
            valid = false;
            break;
        }
        JSObjectRef entry = (JSObjectRef)entry_value;
        JSValueRef oid_value = JSObjectGetPropertyAtIndex(context, entry, 0, exception);
        if (!ct_value_to_uint32_checked(
                context,
                oid_value,
                &parameters[index].oid,
                exception,
                "Invalid PostgreSQL parameter OID"
            )) {
            valid = false;
            break;
        }
        JSValueRef bytes_value = JSObjectGetPropertyAtIndex(context, entry, 1, exception);
        if (exception != NULL && *exception != NULL) {
            valid = false;
            break;
        }
        if (JSValueIsNull(context, bytes_value) || JSValueIsUndefined(context, bytes_value)) {
            parameters[index].flags |= CT_SQL_POSTGRES_PARAMETER_NULL;
        } else {
            uint8_t *parameter_bytes = NULL;
            size_t parameter_len = 0;
            if (ct_get_bytes(context, bytes_value, &parameter_bytes, &parameter_len) != 0) {
                ct_throw_type_error(
                    context,
                    exception,
                    "Normalized PostgreSQL parameter must contain bytes or null"
                );
                valid = false;
                break;
            }
            parameters[index].bytes = parameter_bytes;
            parameters[index].len = parameter_len;
        }
        JSValueRef bytea_value = JSObjectGetPropertyAtIndex(context, entry, 2, exception);
        if (exception != NULL && *exception != NULL) {
            valid = false;
            break;
        }
        if (JSValueToBoolean(context, bytea_value)) {
            parameters[index].flags |= CT_SQL_POSTGRES_PARAMETER_BYTEA;
        }
    }

    if (!valid) {
        free(parameters);
        free(statement);
        return JSValueMakeUndefined(context);
    }

    uint8_t *output = NULL;
    size_t output_len = 0;
    char *error = NULL;
    const int status = ct_sql_postgres_build_extended_query(
        (const uint8_t *)statement,
        statement_len,
        parameters,
        parameter_count,
        &output,
        &output_len,
        &error
    );
    free(parameters);
    free(statement);
    if (status != 0) {
        ct_sql_wire_throw(context, exception, error, "PostgreSQL query serialization failed");
        return JSValueMakeUndefined(context);
    }
    return ct_sql_wire_owned_buffer(context, &output, output_len, exception);
}

static JSValueRef ct_sql_mysql_read_length_encoded_integer_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlMysqlReadLengthEncodedInteger(buffer[, offset]) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "MySQL length-encoded input must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }
    double offset_number = argument_count >= 2 ? JSValueToNumber(context, arguments[1], exception) : 0;
    if ((exception != NULL && *exception != NULL) ||
        !isfinite(offset_number) ||
        offset_number < 0 ||
        offset_number > (double)input_len ||
        floor(offset_number) != offset_number) {
        if (exception == NULL || *exception == NULL) ct_throw_message(context, exception, "Invalid MySQL buffer offset");
        return JSValueMakeUndefined(context);
    }

    uint64_t value = 0;
    size_t next_offset = 0;
    uint8_t is_null = 0;
    char *error = NULL;
    if (ct_sql_mysql_read_length_encoded_integer(
            input,
            input_len,
            (size_t)offset_number,
            &value,
            &next_offset,
            &is_null,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "MySQL length-encoded integer decoding failed");
        return JSValueMakeUndefined(context);
    }

    JSValueRef decoded_value;
    if (is_null != 0) {
        decoded_value = JSValueMakeNull(context);
    } else if (value <= 9007199254740991ULL) {
        decoded_value = JSValueMakeNumber(context, (double)value);
    } else {
        decoded_value = JSBigIntCreateWithUInt64(context, value, exception);
    }
    JSObjectRef result = ct_make_object(context);
    ct_set_property(context, result, "value", decoded_value, exception);
    ct_set_property(context, result, "offset", JSValueMakeNumber(context, (double)next_offset), exception);
    return result;
}

static JSValueRef ct_sql_mysql_decode_column_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlMysqlDecodeColumn(buffer) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "MySQL column definition must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }
    CtSqlMySQLColumn column;
    char *error = NULL;
    if (ct_sql_mysql_decode_column(input, input_len, &column, &error) != 0) {
        ct_sql_wire_throw(context, exception, error, "MySQL column decoding failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef result = ct_make_object(context);
    ct_set_property(context, result, "catalog", ct_sql_wire_slice_string(context, input, input_len, column.catalog, exception), exception);
    ct_set_property(context, result, "schema", ct_sql_wire_slice_string(context, input, input_len, column.schema, exception), exception);
    ct_set_property(context, result, "table", ct_sql_wire_slice_string(context, input, input_len, column.table, exception), exception);
    ct_set_property(context, result, "originalTable", ct_sql_wire_slice_string(context, input, input_len, column.original_table, exception), exception);
    ct_set_property(context, result, "name", ct_sql_wire_slice_string(context, input, input_len, column.name, exception), exception);
    ct_set_property(context, result, "originalName", ct_sql_wire_slice_string(context, input, input_len, column.original_name, exception), exception);
    ct_set_property(context, result, "characterSet", JSValueMakeNumber(context, column.character_set), exception);
    ct_set_property(context, result, "columnLength", JSValueMakeNumber(context, column.column_length), exception);
    ct_set_property(context, result, "type", JSValueMakeNumber(context, column.field_type), exception);
    ct_set_property(context, result, "flags", JSValueMakeNumber(context, column.flags), exception);
    ct_set_property(context, result, "decimals", JSValueMakeNumber(context, column.decimals), exception);
    return result;
}

static JSValueRef ct_sql_mysql_decode_row_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 2) {
        ct_throw_type_error(context, exception, "sqlMysqlDecodeRow(buffer, fieldCount) requires a buffer and field count");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "MySQL row must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }
    double count_number = JSValueToNumber(context, arguments[1], exception);
    if ((exception != NULL && *exception != NULL) ||
        !isfinite(count_number) ||
        count_number < 0 ||
        count_number > UINT32_MAX ||
        floor(count_number) != count_number) {
        if (exception == NULL || *exception == NULL) ct_throw_message(context, exception, "Invalid MySQL row field count");
        return JSValueMakeUndefined(context);
    }

    CtSqlWireSlice *fields = NULL;
    size_t field_count = 0;
    char *error = NULL;
    if (ct_sql_mysql_decode_row(
            input,
            input_len,
            (size_t)count_number,
            &fields,
            &field_count,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "MySQL row decoding failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef result = ct_make_array(context, 0, NULL, exception);
    for (size_t index = 0; index < field_count && (exception == NULL || *exception == NULL); index += 1) {
        JSObjectSetPropertyAtIndex(
            context,
            result,
            (unsigned)index,
            ct_sql_wire_slice_buffer(context, input, input_len, fields[index], exception),
            exception
        );
    }
    ct_sql_wire_free(fields);
    return exception != NULL && *exception != NULL ? JSValueMakeUndefined(context) : result;
}

static JSValueRef ct_sql_mysql_frame_payload_native(
    JSContextRef context,
    JSObjectRef function,
    JSObjectRef this_object,
    size_t argument_count,
    const JSValueRef arguments[],
    JSValueRef *exception
) {
    (void)function;
    (void)this_object;
    if (argument_count < 1) {
        ct_throw_type_error(context, exception, "sqlMysqlFramePayload(buffer[, sequenceId]) requires a buffer");
        return JSValueMakeUndefined(context);
    }

    uint8_t *input = NULL;
    size_t input_len = 0;
    if (!ct_sql_wire_input(
            context,
            arguments[0],
            &input,
            &input_len,
            exception,
            "MySQL packet payload must be an ArrayBuffer or typed array"
        )) {
        return JSValueMakeUndefined(context);
    }
    int sequence_id = 0;
    if (argument_count >= 2 &&
        !ct_value_to_int_checked(
            context,
            arguments[1],
            0,
            UINT8_MAX,
            &sequence_id,
            exception,
            "Invalid MySQL packet sequence ID"
        )) {
        return JSValueMakeUndefined(context);
    }

    uint8_t *output = NULL;
    size_t output_len = 0;
    uint8_t next_sequence_id = 0;
    char *error = NULL;
    if (ct_sql_mysql_frame_payload(
            input,
            input_len,
            (uint8_t)sequence_id,
            &output,
            &output_len,
            &next_sequence_id,
            &error
        ) != 0) {
        ct_sql_wire_throw(context, exception, error, "MySQL packet serialization failed");
        return JSValueMakeUndefined(context);
    }

    JSObjectRef result = ct_make_object(context);
    ct_set_property(
        context,
        result,
        "bytes",
        ct_sql_wire_owned_buffer(context, &output, output_len, exception),
        exception
    );
    ct_set_property(
        context,
        result,
        "nextSequenceId",
        JSValueMakeNumber(context, next_sequence_id),
        exception
    );
    return result;
}
