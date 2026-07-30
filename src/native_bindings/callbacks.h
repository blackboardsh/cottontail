#ifndef COTTONTAIL_NATIVE_BINDINGS_CALLBACKS_H
#define COTTONTAIL_NATIVE_BINDINGS_CALLBACKS_H

#include "registry.h"
#include "http_parser.h"

#define CT_NATIVE_BINDING(name, callback) callback,

static const JSObjectCallAsFunctionCallback ct_runtime_native_callbacks[] = {
#include "runtime.inc"
};

static const JSObjectCallAsFunctionCallback ct_inspector_native_callbacks[] = {
#include "inspector.inc"
};

static const JSObjectCallAsFunctionCallback ct_buffer_native_callbacks[] = {
#include "buffer.inc"
};

static const JSObjectCallAsFunctionCallback ct_filesystem_native_callbacks[] = {
#include "filesystem.inc"
};

static const JSObjectCallAsFunctionCallback ct_glob_native_callbacks[] = {
#include "glob.inc"
};

static const JSObjectCallAsFunctionCallback ct_process_native_callbacks[] = {
#include "process.inc"
};

static const JSObjectCallAsFunctionCallback ct_http_native_callbacks[] = {
#include "http.inc"
};

static const JSObjectCallAsFunctionCallback ct_tooling_native_callbacks[] = {
#include "tooling.inc"
};

static const JSObjectCallAsFunctionCallback ct_memory_ffi_native_callbacks[] = {
#include "memory_ffi.inc"
};

static const JSObjectCallAsFunctionCallback ct_worker_native_callbacks[] = {
#include "worker.inc"
};

static const JSObjectCallAsFunctionCallback ct_system_native_callbacks[] = {
#include "system.inc"
};

static const JSObjectCallAsFunctionCallback ct_compression_native_callbacks[] = {
#include "compression.inc"
};

static const JSObjectCallAsFunctionCallback ct_crypto_native_callbacks[] = {
#include "crypto.inc"
};

static const JSObjectCallAsFunctionCallback ct_data_parser_native_callbacks[] = {
#include "data_parser.inc"
};

static const JSObjectCallAsFunctionCallback ct_dns_native_callbacks[] = {
#include "dns.inc"
};

static const JSObjectCallAsFunctionCallback ct_sockets_native_callbacks[] = {
#include "sockets.inc"
};

static const JSObjectCallAsFunctionCallback ct_tls_native_callbacks[] = {
#include "tls.inc"
};

static const JSObjectCallAsFunctionCallback ct_sqlite_native_callbacks[] = {
#include "sqlite.inc"
};

static const JSObjectCallAsFunctionCallback ct_sql_wire_native_callbacks[] = {
#include "sql_wire.inc"
};

static const JSObjectCallAsFunctionCallback ct_string_width_native_callbacks[] = {
#include "string_width.inc"
};

static const JSObjectCallAsFunctionCallback ct_url_native_callbacks[] = {
#include "url.inc"
};

static const JSObjectCallAsFunctionCallback ct_platform_native_callbacks[] = {
#include "platform.inc"
};

static const JSObjectCallAsFunctionCallback ct_path_native_callbacks[] = {
#include "path.inc"
};

static const JSObjectCallAsFunctionCallback ct_uuid_native_callbacks[] = {
#include "uuid.inc"
};

static const JSObjectCallAsFunctionCallback ct_strip_ansi_native_callbacks[] = {
#include "strip_ansi.inc"
};

#undef CT_NATIVE_BINDING

#define CT_NATIVE_CALLBACK_COUNT(callbacks) (sizeof(callbacks) / sizeof(callbacks[0]))
#define CT_REGISTER_NATIVE_BINDINGS(name) \
    ct_register_##name##_bindings( \
        context, \
        target, \
        runtime, \
        ct_##name##_native_callbacks, \
        CT_NATIVE_CALLBACK_COUNT(ct_##name##_native_callbacks) \
    )

static void ct_register_host_native_bindings(
    JSContextRef context,
    JSObjectRef target,
    CtJscRuntime *runtime
) {
    CT_REGISTER_NATIVE_BINDINGS(runtime);
    CT_REGISTER_NATIVE_BINDINGS(inspector);
    CT_REGISTER_NATIVE_BINDINGS(buffer);
    CT_REGISTER_NATIVE_BINDINGS(filesystem);
    CT_REGISTER_NATIVE_BINDINGS(glob);
    CT_REGISTER_NATIVE_BINDINGS(process);
    CT_REGISTER_NATIVE_BINDINGS(http);
    CT_REGISTER_NATIVE_BINDINGS(tooling);
    CT_REGISTER_NATIVE_BINDINGS(memory_ffi);
    CT_REGISTER_NATIVE_BINDINGS(worker);
    CT_REGISTER_NATIVE_BINDINGS(system);
    CT_REGISTER_NATIVE_BINDINGS(compression);
    CT_REGISTER_NATIVE_BINDINGS(crypto);
    CT_REGISTER_NATIVE_BINDINGS(data_parser);
    CT_REGISTER_NATIVE_BINDINGS(dns);
    CT_REGISTER_NATIVE_BINDINGS(sockets);
    CT_REGISTER_NATIVE_BINDINGS(tls);
    CT_REGISTER_NATIVE_BINDINGS(sqlite);
    CT_REGISTER_NATIVE_BINDINGS(sql_wire);
    CT_REGISTER_NATIVE_BINDINGS(string_width);
    CT_REGISTER_NATIVE_BINDINGS(url);
    CT_REGISTER_NATIVE_BINDINGS(platform);
    CT_REGISTER_NATIVE_BINDINGS(path);
    CT_REGISTER_NATIVE_BINDINGS(uuid);
    CT_REGISTER_NATIVE_BINDINGS(strip_ansi);
}

#undef CT_REGISTER_NATIVE_BINDINGS
#undef CT_NATIVE_CALLBACK_COUNT

#endif
