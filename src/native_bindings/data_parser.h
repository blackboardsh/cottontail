#ifndef COTTONTAIL_DATA_PARSER_H
#define COTTONTAIL_DATA_PARSER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

uintptr_t ct_yaml_parser_parse(
    const uint8_t *input,
    size_t input_len,
    void *builder
);

uintptr_t ct_data_parser_builder_make_null(void *builder);
uintptr_t ct_data_parser_builder_make_undefined(void *builder);
uintptr_t ct_data_parser_builder_make_boolean(void *builder, bool value);
uintptr_t ct_data_parser_builder_make_number(void *builder, double value);
uintptr_t ct_data_parser_builder_make_string(void *builder, const uint8_t *value, size_t len);
uintptr_t ct_data_parser_builder_make_array(void *builder, size_t len);
uintptr_t ct_data_parser_builder_make_object(void *builder);
bool ct_data_parser_builder_set_index(void *builder, uintptr_t array, size_t index, uintptr_t value);
bool ct_data_parser_builder_set_property(void *builder, uintptr_t object, uintptr_t key, uintptr_t value);
void ct_data_parser_builder_set_error(
    void *builder,
    int kind,
    const uint8_t *message,
    size_t len
);

#endif
