#ifndef COTTONTAIL_JSC_RUNNER_H
#define COTTONTAIL_JSC_RUNNER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct CtJscRuntime CtJscRuntime;

enum {
    CT_JSC_EVAL_RELOAD = 2,
};

CtJscRuntime *ct_jsc_runtime_create(void);
CtJscRuntime *ct_jsc_runtime_create_with_stack_size(size_t stack_size);
void ct_jsc_runtime_destroy(CtJscRuntime *runtime);
int ct_jsc_runtime_set_exit_cleanup_path(CtJscRuntime *runtime, const char *path);
int ct_jsc_runtime_set_args(
    CtJscRuntime *runtime,
    size_t argc,
    const char *const *argv,
    size_t user_arg_offset,
    size_t exec_argc,
    const char *const *exec_argv,
    char **error_out
);
int ct_jsc_runtime_set_standalone_files(
    CtJscRuntime *runtime,
    const uint8_t *data,
    size_t data_len,
    char **error_out
);
int ct_jsc_runtime_eval(
    CtJscRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    char **error_out
);
int ct_jsc_runtime_eval_immediate(
    CtJscRuntime *runtime,
    const uint8_t *source,
    size_t source_len,
    const char *filename,
    char **error_out
);
int ct_jsc_runtime_set_watch_paths(
    CtJscRuntime *runtime,
    size_t path_count,
    const char *const *paths,
    char **error_out
);
bool ct_jsc_runtime_take_reload_request(CtJscRuntime *runtime);
int ct_jsc_runtime_wait_for_reload(CtJscRuntime *runtime, char **error_out);
int ct_jsc_runtime_prepare_hot_reload(CtJscRuntime *runtime, char **error_out);
int ct_jsc_runtime_exit_code(CtJscRuntime *runtime);
int ct_jsc_runtime_tick(CtJscRuntime *runtime, char **error_out);
int ct_jsc_runtime_start_inspector(
    CtJscRuntime *runtime,
    const char *host,
    uint16_t port,
    const char *path,
    bool pause_on_start,
    char **url_out,
    char **error_out
);
void ct_jsc_runtime_stop_inspector(CtJscRuntime *runtime);
char *ct_jsc_runtime_inspector_url(CtJscRuntime *runtime);
int ct_jsc_runtime_wait_for_inspector(CtJscRuntime *runtime);
bool ct_jsc_runtime_enable_sampling_profiler(CtJscRuntime *runtime);
char *ct_jsc_runtime_take_sampling_profiler(CtJscRuntime *runtime);
char *ct_jsc_runtime_take_heap_snapshot(CtJscRuntime *runtime, bool gc_debugging);
void ct_jsc_string_free(char *value);

#endif
