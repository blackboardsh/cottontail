#ifndef COTTONTAIL_QJS_RUNNER_H
#define COTTONTAIL_QJS_RUNNER_H

#include <stddef.h>
#include <stdint.h>

typedef struct CtQjsRuntime CtQjsRuntime;

CtQjsRuntime *ct_qjs_runtime_create(void);
CtQjsRuntime *ct_qjs_runtime_create_with_stack_size(size_t stack_size);
void ct_qjs_runtime_destroy(CtQjsRuntime *runtime);
int ct_qjs_runtime_set_args(
    CtQjsRuntime *runtime,
    size_t argc,
    const char *const *argv,
    char **error_out
);
int ct_qjs_runtime_eval(
    CtQjsRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    char **error_out
);
int ct_qjs_runtime_tick(CtQjsRuntime *runtime, char **error_out);
void ct_qjs_string_free(char *value);

#endif
