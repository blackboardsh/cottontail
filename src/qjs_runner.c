#include "qjs_runner.h"

#include <stdio.h>
#include <stdlib.h>

#include "quickjs.h"

static JSValue ct_console_log(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;

    for (int i = 0; i < argc; i += 1) {
        const char *value = JS_ToCString(ctx, argv[i]);
        if (value == NULL) {
            return JS_EXCEPTION;
        }

        if (i > 0) {
            fputc(' ', stdout);
        }

        fputs(value, stdout);
        JS_FreeCString(ctx, value);
    }

    fputc('\n', stdout);
    fflush(stdout);
    return JS_UNDEFINED;
}

static JSValue ct_console_error(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;

    for (int i = 0; i < argc; i += 1) {
        const char *value = JS_ToCString(ctx, argv[i]);
        if (value == NULL) {
            return JS_EXCEPTION;
        }

        if (i > 0) {
            fputc(' ', stderr);
        }

        fputs(value, stderr);
        JS_FreeCString(ctx, value);
    }

    fputc('\n', stderr);
    fflush(stderr);
    return JS_UNDEFINED;
}

static int ct_install_console(JSContext *ctx) {
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_NewObject(ctx);

    if (JS_IsException(console)) {
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, ct_console_log, "log", 1)) < 0) {
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, console, "error", JS_NewCFunction(ctx, ct_console_error, "error", 1)) < 0) {
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    if (JS_SetPropertyStr(ctx, global, "console", console) < 0) {
        JS_FreeValue(ctx, console);
        JS_FreeValue(ctx, global);
        return -1;
    }

    JS_FreeValue(ctx, global);
    return 0;
}

static int ct_dump_exception(JSContext *ctx) {
    JSValue exception = JS_GetException(ctx);
    const char *message = NULL;
    const char *stack_message = NULL;

    if (JS_IsError(exception)) {
        JSValue stack = JS_GetPropertyStr(ctx, exception, "stack");
        if (!JS_IsUndefined(stack)) {
            stack_message = JS_ToCString(ctx, stack);
        }
        JS_FreeValue(ctx, stack);
    }

    message = JS_ToCString(ctx, exception);
    if (message != NULL) {
        fprintf(stderr, "%s\n", message);
        JS_FreeCString(ctx, message);
    } else {
        fprintf(stderr, "Unknown JavaScript exception\n");
    }

    if (stack_message != NULL) {
        fprintf(stderr, "%s\n", stack_message);
        JS_FreeCString(ctx, stack_message);
    }

    JS_FreeValue(ctx, exception);
    return 1;
}

static int ct_read_file(const char *path, char **out_buf, size_t *out_len) {
    FILE *file = fopen(path, "rb");
    char *buffer = NULL;
    size_t size = 0;

    if (file == NULL) {
        fprintf(stderr, "cottontail: failed to open script: %s\n", path);
        return 1;
    }

    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        fprintf(stderr, "cottontail: failed to seek script: %s\n", path);
        return 1;
    }

    long file_size = ftell(file);
    if (file_size < 0) {
        fclose(file);
        fprintf(stderr, "cottontail: failed to determine script size: %s\n", path);
        return 1;
    }

    if (fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        fprintf(stderr, "cottontail: failed to rewind script: %s\n", path);
        return 1;
    }

    size = (size_t) file_size;
    buffer = (char *) malloc(size + 1);
    if (buffer == NULL) {
        fclose(file);
        fprintf(stderr, "cottontail: out of memory reading script: %s\n", path);
        return 1;
    }

    if (size > 0 && fread(buffer, 1, size, file) != size) {
        fclose(file);
        free(buffer);
        fprintf(stderr, "cottontail: failed to read script: %s\n", path);
        return 1;
    }

    buffer[size] = '\0';
    fclose(file);

    *out_buf = buffer;
    *out_len = size;
    return 0;
}

int ct_run_file(const char *script_path) {
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *context = NULL;
    char *script = NULL;
    size_t script_len = 0;
    int exit_code = 1;

    if (runtime == NULL) {
        fprintf(stderr, "cottontail: failed to create QuickJS runtime\n");
        return 1;
    }

    context = JS_NewContext(runtime);
    if (context == NULL) {
        fprintf(stderr, "cottontail: failed to create QuickJS context\n");
        JS_FreeRuntime(runtime);
        return 1;
    }

    if (ct_install_console(context) != 0) {
        fprintf(stderr, "cottontail: failed to install console bindings\n");
        goto cleanup;
    }

    if (ct_read_file(script_path, &script, &script_len) != 0) {
        goto cleanup;
    }

    JSValue result = JS_Eval(context, script, script_len, script_path, JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JS_FreeValue(context, result);
        exit_code = ct_dump_exception(context);
        goto cleanup;
    }

    JS_FreeValue(context, result);
    exit_code = 0;

cleanup:
    free(script);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return exit_code;
}
