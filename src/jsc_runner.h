#ifndef COTTONTAIL_JSC_RUNNER_H
#define COTTONTAIL_JSC_RUNNER_H

#include <stddef.h>
#include <stdint.h>

typedef struct CtJscRuntime CtJscRuntime;

CtJscRuntime *ct_jsc_runtime_create(void);
CtJscRuntime *ct_jsc_runtime_create_with_stack_size(size_t stack_size);
void ct_jsc_runtime_destroy(CtJscRuntime *runtime);
int ct_jsc_runtime_set_args(
    CtJscRuntime *runtime,
    size_t argc,
    const char *const *argv,
    char **error_out
);
int ct_jsc_runtime_eval(
    CtJscRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    char **error_out
);
int ct_jsc_runtime_tick(CtJscRuntime *runtime, char **error_out);
void ct_jsc_string_free(char *value);

#endif
