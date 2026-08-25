static CtSqliteDb *ct_sqlite_find_db(uint32_t id) {
    CtSqliteDb *cursor = ct_sqlite_dbs;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static CtSqliteStmt *ct_sqlite_find_stmt(uint32_t id) {
    CtSqliteStmt *cursor = ct_sqlite_stmts;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static CtSqliteSession *ct_sqlite_find_session(uint32_t id) {
    CtSqliteSession *cursor = ct_sqlite_sessions;
    while (cursor != NULL) {
        if (cursor->id == id) return cursor;
        cursor = cursor->next;
    }
    return NULL;
}

static CtSqliteEnableLoadExtensionFn ct_sqlite_enable_load_extension_fn(void) {
    return sqlite3_enable_load_extension;
}

static CtSqliteLoadExtensionFn ct_sqlite_load_extension_fn(void) {
    return sqlite3_load_extension;
}

static void ct_sqlite_throw(JSContextRef ctx, JSValueRef *exception, sqlite3 *db) {
    ct_throw_message(ctx, exception, db != NULL ? sqlite3_errmsg(db) : "SQLite error");
}

static void ct_sqlite_unlink_stmt(CtSqliteStmt *stmt) {
    if (stmt == NULL) return;
    CtSqliteStmt **global_cursor = &ct_sqlite_stmts;
    while (*global_cursor != NULL) {
        if (*global_cursor == stmt) {
            *global_cursor = stmt->next;
            break;
        }
        global_cursor = &(*global_cursor)->next;
    }
    if (stmt->owner != NULL) {
        CtSqliteStmt **owner_cursor = &stmt->owner->statements;
        while (*owner_cursor != NULL) {
            if (*owner_cursor == stmt) {
                *owner_cursor = stmt->owner_next;
                break;
            }
            owner_cursor = &(*owner_cursor)->owner_next;
        }
    }
}

static void ct_sqlite_finalize_stmt(CtSqliteStmt *stmt) {
    if (stmt == NULL) return;
    ct_sqlite_unlink_stmt(stmt);
    for (int index = 0; index < stmt->column_count; index += 1) {
        if (stmt->column_names[index] != NULL) JSStringRelease(stmt->column_names[index]);
    }
    free(stmt->column_names);
    if (stmt->stmt != NULL) sqlite3_finalize(stmt->stmt);
    free(stmt);
}

static void ct_sqlite_unlink_session(CtSqliteSession *session) {
    if (session == NULL) return;
    CtSqliteSession **global_cursor = &ct_sqlite_sessions;
    while (*global_cursor != NULL) {
        if (*global_cursor == session) {
            *global_cursor = session->next;
            break;
        }
        global_cursor = &(*global_cursor)->next;
    }
    if (session->owner != NULL) {
        CtSqliteSession **owner_cursor = &session->owner->sessions;
        while (*owner_cursor != NULL) {
            if (*owner_cursor == session) {
                *owner_cursor = session->owner_next;
                break;
            }
            owner_cursor = &(*owner_cursor)->owner_next;
        }
    }
}

static void ct_sqlite_delete_session(CtSqliteSession *session) {
    if (session == NULL) return;
    ct_sqlite_unlink_session(session);
    if (session->session != NULL) sqlite3session_delete(session->session);
    free(session);
}

static JSValueRef ct_sqlite_column_value(JSContextRef ctx, sqlite3_stmt *stmt, int column, bool safe_integers, JSValueRef *exception) {
    int type = sqlite3_column_type(stmt, column);
    switch (type) {
        case SQLITE_INTEGER: {
            sqlite3_int64 value = sqlite3_column_int64(stmt, column);
            if (safe_integers) return JSBigIntCreateWithInt64(ctx, value, exception);
            return JSValueMakeNumber(ctx, (double)value);
        }
        case SQLITE_FLOAT:
            return JSValueMakeNumber(ctx, sqlite3_column_double(stmt, column));
        case SQLITE_TEXT:
            return ct_make_string_len(ctx, (const char *)sqlite3_column_text(stmt, column), (size_t)sqlite3_column_bytes(stmt, column));
        case SQLITE_BLOB:
            return ct_uint8_array_from_copy(ctx, (const char *)sqlite3_column_blob(stmt, column), (size_t)sqlite3_column_bytes(stmt, column), exception);
        case SQLITE_NULL:
        default:
            return JSValueMakeNull(ctx);
    }
}

static JSObjectRef ct_sqlite_row_object(JSContextRef ctx, CtSqliteStmt *entry, bool safe_integers, JSValueRef *exception) {
    sqlite3_stmt *stmt = entry->stmt;
    int count = entry->column_count;
    JSObjectRef row = ct_make_object(ctx);
    for (int index = 0; index < count; index += 1) {
        JSObjectSetProperty(ctx, row, entry->column_names[index],
            ct_sqlite_column_value(ctx, stmt, index, safe_integers, exception),
            kJSPropertyAttributeNone, exception);
    }
    return row;
}

static JSObjectRef ct_sqlite_row_array(JSContextRef ctx, sqlite3_stmt *stmt, bool safe_integers, JSValueRef *exception) {
    int count = sqlite3_column_count(stmt);
    JSObjectRef row = ct_make_array(ctx, 0, NULL, exception);
    for (int index = 0; index < count; index += 1) {
        JSObjectSetPropertyAtIndex(ctx, row, (unsigned)index, ct_sqlite_column_value(ctx, stmt, index, safe_integers, exception), exception);
    }
    return row;
}

static int ct_sqlite_bind_string_value(JSContextRef ctx, sqlite3_stmt *stmt, int index, JSValueRef value, JSValueRef *exception) {
    JSStringRef string = JSValueToStringCopy(ctx, value, exception);
    if (string == NULL) return SQLITE_MISUSE;

    const size_t length = JSStringGetLength(string);
    const JSChar *characters = JSStringGetCharactersPtr(string);
    for (size_t offset = 0; offset < length; offset += 1) {
        // COTTONTAIL-COMPAT: Bun treats the byte-order-mark inverse as an
        // invalid text conversion and binds an empty string, like lone surrogates.
        if (characters != NULL && characters[offset] == 0xfffe) {
            JSStringRelease(string);
            return sqlite3_bind_text(stmt, index, "", 0, SQLITE_TRANSIENT);
        }
    }

    const size_t capacity = JSStringGetMaximumUTF8CStringSize(string);
    char *text = (char *)malloc(capacity > 0 ? capacity : 1);
    if (text == NULL) {
        JSStringRelease(string);
        ct_throw_message(ctx, exception, "Out of memory");
        return SQLITE_NOMEM;
    }
    const size_t written = JSStringGetUTF8CString(string, text, capacity);
    JSStringRelease(string);
    const size_t text_length = written > 0 ? written - 1 : 0;
    if (text_length > INT_MAX) {
        free(text);
        ct_throw_message(ctx, exception, "SQLite bind parameter is too large");
        return SQLITE_TOOBIG;
    }
    const int status = sqlite3_bind_text(stmt, index, text, (int)text_length, SQLITE_TRANSIENT);
    free(text);
    return status;
}

static int ct_sqlite_bind_value(JSContextRef ctx, sqlite3_stmt *stmt, int index, JSValueRef value, JSValueRef *exception) {
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) return sqlite3_bind_null(stmt, index);
    if (JSValueIsBoolean(ctx, value)) return sqlite3_bind_int(stmt, index, ct_value_to_bool(ctx, value) ? 1 : 0);
    if (JSValueIsNumber(ctx, value)) return sqlite3_bind_double(stmt, index, ct_value_to_number(ctx, value));
    if (JSValueIsString(ctx, value)) return ct_sqlite_bind_string_value(ctx, stmt, index, value, exception);
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &bytes_len) == 0) {
        return sqlite3_bind_blob(stmt, index, bytes, (int)bytes_len, SQLITE_TRANSIENT);
    }
    return ct_sqlite_bind_string_value(ctx, stmt, index, value, exception);
}

static int ct_sqlite_bind_params(JSContextRef ctx, sqlite3_stmt *stmt, JSValueRef params, JSValueRef *exception) {
    sqlite3_reset(stmt);
    sqlite3_clear_bindings(stmt);
    if (params == NULL || JSValueIsUndefined(ctx, params) || JSValueIsNull(ctx, params)) return SQLITE_OK;
    if (!JSValueIsObject(ctx, params)) return SQLITE_OK;

    JSObjectRef object = (JSObjectRef)params;
    JSValueRef length_value = ct_get_property(ctx, object, "length", exception);
    if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
    size_t count = JSValueIsUndefined(ctx, length_value) ? 0 : (size_t)ct_value_to_number(ctx, length_value);
    if (count > 0) {
        for (size_t index = 0; index < count; index += 1) {
            JSValueRef value = JSObjectGetPropertyAtIndex(ctx, object, (unsigned)index, exception);
            if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
            int status = ct_sqlite_bind_value(ctx, stmt, (int)index + 1, value, exception);
            if (status != SQLITE_OK) return status;
        }
        return SQLITE_OK;
    }

    int bind_count = sqlite3_bind_parameter_count(stmt);
    for (int index = 1; index <= bind_count; index += 1) {
        const char *name = sqlite3_bind_parameter_name(stmt, index);
        if (name == NULL || name[0] == '\0') continue;
        JSValueRef value = ct_get_property(ctx, object, name, exception);
        if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
        if (JSValueIsUndefined(ctx, value) && (name[0] == ':' || name[0] == '$' || name[0] == '@')) {
            value = ct_get_property(ctx, object, name + 1, exception);
            if (exception != NULL && *exception != NULL) return SQLITE_MISUSE;
        }
        int status = ct_sqlite_bind_value(ctx, stmt, index, value, exception);
        if (status != SQLITE_OK) return status;
    }
    return SQLITE_OK;
}

static JSValueRef ct_sqlite_value_to_js(JSContextRef ctx, sqlite3_value *value, JSValueRef *exception) {
    switch (sqlite3_value_type(value)) {
        case SQLITE_INTEGER:
            return JSValueMakeNumber(ctx, (double)sqlite3_value_int64(value));
        case SQLITE_FLOAT:
            return JSValueMakeNumber(ctx, sqlite3_value_double(value));
        case SQLITE_TEXT:
            return ct_make_string_len(ctx, (const char *)sqlite3_value_text(value), (size_t)sqlite3_value_bytes(value));
        case SQLITE_BLOB:
            return ct_array_buffer_from_copy(ctx, (const char *)sqlite3_value_blob(value), (size_t)sqlite3_value_bytes(value), exception);
        case SQLITE_NULL:
        default:
            return JSValueMakeNull(ctx);
    }
}

static void ct_sqlite_result_from_js(sqlite3_context *sqlite_ctx, JSContextRef ctx, JSValueRef value) {
    if (value == NULL || JSValueIsUndefined(ctx, value) || JSValueIsNull(ctx, value)) {
        sqlite3_result_null(sqlite_ctx);
        return;
    }
    if (JSValueIsBoolean(ctx, value)) {
        sqlite3_result_int(sqlite_ctx, ct_value_to_bool(ctx, value) ? 1 : 0);
        return;
    }
    if (JSValueIsNumber(ctx, value)) {
        double number = ct_value_to_number(ctx, value);
        sqlite3_result_double(sqlite_ctx, number);
        return;
    }
    if (JSValueIsString(ctx, value)) {
        char *text = ct_value_to_string_copy(ctx, value);
        if (text == NULL) {
            sqlite3_result_error_nomem(sqlite_ctx);
            return;
        }
        sqlite3_result_text(sqlite_ctx, text, -1, SQLITE_TRANSIENT);
        free(text);
        return;
    }
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, value, &bytes, &bytes_len) == 0) {
        sqlite3_result_blob(sqlite_ctx, bytes, (int)bytes_len, SQLITE_TRANSIENT);
        return;
    }
    sqlite3_result_error(sqlite_ctx, "Unsupported SQLite function return value", -1);
}

static void ct_sqlite_function_destroy(void *opaque) {
    CtSqliteFunction *entry = (CtSqliteFunction *)opaque;
    if (entry == NULL) return;
    if (entry->ctx != NULL && entry->callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->callback);
    }
    if (entry->ctx != NULL && entry->result_callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->result_callback);
    }
    if (entry->ctx != NULL && entry->start_callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->start_callback);
    }
    if (entry->ctx != NULL && entry->inverse_callback != NULL) {
        JSValueUnprotect(entry->ctx, entry->inverse_callback);
    }
    if (entry->ctx != NULL && entry->has_start_value && entry->start_value != NULL) {
        JSValueUnprotect(entry->ctx, entry->start_value);
    }
    free(entry);
}

static JSValueRef ct_sqlite_authorizer_string(JSContextRef ctx, const char *value) {
    return value != NULL ? ct_make_string(ctx, value) : JSValueMakeNull(ctx);
}

static int ct_sqlite_authorizer_call(void *opaque, int action_code, const char *arg1, const char *arg2, const char *database_name, const char *trigger_or_view) {
    CtSqliteFunction *entry = (CtSqliteFunction *)opaque;
    if (entry == NULL || entry->ctx == NULL || entry->callback == NULL) return SQLITE_DENY;

    JSValueRef args[] = {
        JSValueMakeNumber(entry->ctx, action_code),
        ct_sqlite_authorizer_string(entry->ctx, arg1),
        ct_sqlite_authorizer_string(entry->ctx, arg2),
        ct_sqlite_authorizer_string(entry->ctx, database_name),
        ct_sqlite_authorizer_string(entry->ctx, trigger_or_view),
    };
    JSValueRef exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(entry->ctx, entry->callback, NULL, 5, args, &exception);
    if (exception != NULL) return SQLITE_DENY;
    double number = JSValueToNumber(entry->ctx, result, &exception);
    if (exception != NULL || !isfinite(number)) return SQLITE_DENY;
    int code = (int)number;
    if ((double)code != number) return SQLITE_DENY;
    if (code == SQLITE_OK || code == SQLITE_DENY || code == SQLITE_IGNORE) return code;
    return SQLITE_DENY;
}

static void ct_sqlite_function_call(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    if (entry == NULL || entry->ctx == NULL || entry->callback == NULL) {
        sqlite3_result_error(sqlite_ctx, "SQLite function callback is unavailable", -1);
        return;
    }

    JSValueRef *args = (JSValueRef *)calloc((size_t)(argc > 0 ? argc : 1), sizeof(JSValueRef));
    if (args == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    JSValueRef exception = NULL;
    for (int index = 0; index < argc; index += 1) {
        args[index] = ct_sqlite_value_to_js(entry->ctx, argv[index], &exception);
        if (exception != NULL) {
            char *message = ct_copy_exception(entry->ctx, exception);
            sqlite3_result_error(sqlite_ctx, message != NULL ? message : "SQLite function argument conversion failed", -1);
            free(message);
            free(args);
            return;
        }
    }

    JSValueRef result = JSObjectCallAsFunction(entry->ctx, entry->callback, NULL, (size_t)argc, args, &exception);
    free(args);
    if (exception != NULL) {
        char *message = ct_copy_exception(entry->ctx, exception);
        sqlite3_result_error(sqlite_ctx, message != NULL ? message : "SQLite function callback failed", -1);
        free(message);
        return;
    }
    ct_sqlite_result_from_js(sqlite_ctx, entry->ctx, result);
}

static void ct_sqlite_aggregate_state_set_error(sqlite3_context *sqlite_ctx, CtSqliteAggregateState *state, char *message, const char *fallback) {
    const char *text = fallback;
    if (state != NULL) {
        if (state->error_message == NULL) {
            state->error_message = message != NULL ? message : ct_duplicate_bytes(fallback, strlen(fallback));
        } else {
            free(message);
        }
        text = state->error_message != NULL ? state->error_message : fallback;
    } else if (message != NULL) {
        text = message;
    }
    sqlite3_result_error(sqlite_ctx, text != NULL ? text : "SQLite aggregate callback failed", -1);
    if (state == NULL) {
        free(message);
    }
}

static void ct_sqlite_aggregate_state_clear(CtSqliteFunction *entry, CtSqliteAggregateState *state) {
    if (entry == NULL || state == NULL) return;
    if (entry->ctx != NULL && state->initialized && state->accumulator != NULL) {
        JSValueUnprotect(entry->ctx, state->accumulator);
    }
    free(state->error_message);
    state->initialized = false;
    state->accumulator = NULL;
    state->error_message = NULL;
}

static bool ct_sqlite_aggregate_initialize(sqlite3_context *sqlite_ctx, CtSqliteFunction *entry, CtSqliteAggregateState *state) {
    if (entry == NULL || entry->ctx == NULL || state == NULL) return false;
    if (state->initialized) return state->error_message == NULL;

    JSValueRef accumulator = NULL;
    if (entry->start_callback != NULL) {
        JSValueRef exception = NULL;
        accumulator = JSObjectCallAsFunction(entry->ctx, entry->start_callback, NULL, 0, NULL, &exception);
        if (exception != NULL) {
            ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), "SQLite aggregate start callback failed");
            return false;
        }
    } else if (entry->has_start_value) {
        accumulator = entry->start_value;
    } else {
        accumulator = JSValueMakeUndefined(entry->ctx);
    }

    JSValueProtect(entry->ctx, accumulator);
    state->accumulator = accumulator;
    state->initialized = true;
    return true;
}

static void ct_sqlite_aggregate_call(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv, JSObjectRef callback, const char *name) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    if (entry == NULL || entry->ctx == NULL || callback == NULL) {
        sqlite3_result_error(sqlite_ctx, "SQLite aggregate callback is unavailable", -1);
        return;
    }

    CtSqliteAggregateState *state = (CtSqliteAggregateState *)sqlite3_aggregate_context(sqlite_ctx, sizeof(CtSqliteAggregateState));
    if (state == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    if (state->error_message != NULL) {
        sqlite3_result_error(sqlite_ctx, state->error_message, -1);
        return;
    }
    if (!ct_sqlite_aggregate_initialize(sqlite_ctx, entry, state)) return;

    size_t js_argc = (size_t)argc + 1;
    JSValueRef *args = (JSValueRef *)calloc(js_argc > 0 ? js_argc : 1, sizeof(JSValueRef));
    if (args == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    args[0] = state->accumulator;

    JSValueRef exception = NULL;
    for (int index = 0; index < argc; index += 1) {
        args[(size_t)index + 1] = ct_sqlite_value_to_js(entry->ctx, argv[index], &exception);
        if (exception != NULL) {
            ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), "SQLite aggregate argument conversion failed");
            free(args);
            return;
        }
    }

    JSValueRef result = JSObjectCallAsFunction(entry->ctx, callback, NULL, js_argc, args, &exception);
    free(args);
    if (exception != NULL) {
        char fallback[128];
        snprintf(fallback, sizeof(fallback), "SQLite aggregate %s callback failed", name != NULL ? name : "step");
        ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), fallback);
        return;
    }

    JSValueProtect(entry->ctx, result);
    if (state->accumulator != NULL) JSValueUnprotect(entry->ctx, state->accumulator);
    state->accumulator = result;
}

static void ct_sqlite_aggregate_step(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    ct_sqlite_aggregate_call(sqlite_ctx, argc, argv, entry != NULL ? entry->callback : NULL, "step");
}

static void ct_sqlite_aggregate_inverse(sqlite3_context *sqlite_ctx, int argc, sqlite3_value **argv) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    ct_sqlite_aggregate_call(sqlite_ctx, argc, argv, entry != NULL ? entry->inverse_callback : NULL, "inverse");
}

static void ct_sqlite_aggregate_emit_result(sqlite3_context *sqlite_ctx, bool clear_state) {
    CtSqliteFunction *entry = (CtSqliteFunction *)sqlite3_user_data(sqlite_ctx);
    if (entry == NULL || entry->ctx == NULL) {
        sqlite3_result_error(sqlite_ctx, "SQLite aggregate callback is unavailable", -1);
        return;
    }

    CtSqliteAggregateState *state = (CtSqliteAggregateState *)sqlite3_aggregate_context(sqlite_ctx, sizeof(CtSqliteAggregateState));
    if (state == NULL) {
        sqlite3_result_error_nomem(sqlite_ctx);
        return;
    }
    if (state->error_message != NULL) {
        sqlite3_result_error(sqlite_ctx, state->error_message, -1);
        if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
        return;
    }
    if (!ct_sqlite_aggregate_initialize(sqlite_ctx, entry, state)) {
        if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
        return;
    }

    JSValueRef result = state->accumulator;
    if (entry->result_callback != NULL) {
        JSValueRef exception = NULL;
        JSValueRef arg = state->accumulator;
        result = JSObjectCallAsFunction(entry->ctx, entry->result_callback, NULL, 1, &arg, &exception);
        if (exception != NULL) {
            ct_sqlite_aggregate_state_set_error(sqlite_ctx, state, ct_copy_exception(entry->ctx, exception), "SQLite aggregate result callback failed");
            if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
            return;
        }
    }

    ct_sqlite_result_from_js(sqlite_ctx, entry->ctx, result);
    if (clear_state) ct_sqlite_aggregate_state_clear(entry, state);
}

static void ct_sqlite_aggregate_value(sqlite3_context *sqlite_ctx) {
    ct_sqlite_aggregate_emit_result(sqlite_ctx, false);
}

static void ct_sqlite_aggregate_final(sqlite3_context *sqlite_ctx) {
    ct_sqlite_aggregate_emit_result(sqlite_ctx, true);
}

static JSValueRef ct_sqlite_open(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteOpen(path) requires a path");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[0]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    sqlite3 *db = NULL;
    int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI;
    if (argc >= 3 && !JSValueIsUndefined(ctx, argv[2]) && !JSValueIsNull(ctx, argv[2])) {
        flags = (int)ct_value_to_number(ctx, argv[2]);
    }
    int status = sqlite3_open_v2(path, &db, flags, NULL);
    free(path);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, db);
        if (db != NULL) sqlite3_close(db);
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = (CtSqliteDb *)calloc(1, sizeof(CtSqliteDb));
    if (entry == NULL) {
        sqlite3_close(db);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    entry->id = ct_next_sqlite_db_id++;
    if (ct_next_sqlite_db_id == 0) ct_next_sqlite_db_id = 1;
    entry->db = db;
    entry->allow_load_extension = argc >= 2 && ct_value_to_bool(ctx, argv[1]);
    entry->load_extension_enabled = entry->allow_load_extension;
    CtSqliteEnableLoadExtensionFn enable_load_extension = ct_sqlite_enable_load_extension_fn();
    if (enable_load_extension != NULL) {
        enable_load_extension(db, entry->load_extension_enabled ? 1 : 0);
    }
    entry->next = ct_sqlite_dbs;
    ct_sqlite_dbs = entry;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, entry->id), exception);
    return result;
}

static JSValueRef ct_sqlite_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteClose(id) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    uint32_t id = (uint32_t)ct_value_to_number(ctx, argv[0]);
    CtSqliteDb **cursor = &ct_sqlite_dbs;
    while (*cursor != NULL && (*cursor)->id != id) cursor = &(*cursor)->next;
    if (*cursor == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = *cursor;
    while (entry->sessions != NULL) ct_sqlite_delete_session(entry->sessions);
    while (entry->statements != NULL) ct_sqlite_finalize_stmt(entry->statements);
    sqlite3_set_authorizer(entry->db, NULL, NULL);
    if (entry->authorizer != NULL) {
        ct_sqlite_function_destroy(entry->authorizer);
        entry->authorizer = NULL;
    }
    int status = sqlite3_close(entry->db);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    *cursor = entry->next;
    free(entry);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_exec(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteExec(id, sql) requires database id and SQL");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *sql = ct_value_to_string_copy(ctx, argv[1]);
    if (sql == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    char *error_message = NULL;
    int status = sqlite3_exec(entry->db, sql, NULL, NULL, &error_message);
    free(sql);
    if (status != SQLITE_OK) {
        ct_throw_message(ctx, exception, error_message != NULL ? error_message : sqlite3_errmsg(entry->db));
        sqlite3_free(error_message);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_prepare(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqlitePrepare(id, sql) requires database id and SQL");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *sql = ct_value_to_string_copy(ctx, argv[1]);
    if (sql == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_stmt *stmt = NULL;
    int status = sqlite3_prepare_v2(entry->db, sql, -1, &stmt, NULL);
    free(sql);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    if (stmt == NULL) {
        ct_throw_message(ctx, exception, "Query contained no valid SQL statement; likely empty query.");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *stmt_entry = (CtSqliteStmt *)calloc(1, sizeof(CtSqliteStmt));
    if (stmt_entry == NULL) {
        sqlite3_finalize(stmt);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    stmt_entry->id = ct_next_sqlite_stmt_id++;
    if (ct_next_sqlite_stmt_id == 0) ct_next_sqlite_stmt_id = 1;
    stmt_entry->stmt = stmt;
    stmt_entry->owner = entry;
    stmt_entry->column_count = sqlite3_column_count(stmt);
    if (stmt_entry->column_count > 0) {
        stmt_entry->column_names = (JSStringRef *)calloc((size_t)stmt_entry->column_count, sizeof(JSStringRef));
        if (stmt_entry->column_names == NULL) {
            sqlite3_finalize(stmt);
            free(stmt_entry);
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
        for (int index = 0; index < stmt_entry->column_count; index += 1) {
            const char *name = sqlite3_column_name(stmt, index);
            stmt_entry->column_names[index] = JSStringCreateWithUTF8CString(name != NULL ? name : "");
            if (stmt_entry->column_names[index] == NULL) {
                ct_sqlite_finalize_stmt(stmt_entry);
                ct_throw_message(ctx, exception, "Out of memory");
                return JSValueMakeUndefined(ctx);
            }
        }
    }
    stmt_entry->next = ct_sqlite_stmts;
    ct_sqlite_stmts = stmt_entry;
    stmt_entry->owner_next = entry->statements;
    entry->statements = stmt_entry;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, stmt_entry->id), exception);
    ct_set_property(ctx, result, "sourceSQL", ct_make_string(ctx, sqlite3_sql(stmt) != NULL ? sqlite3_sql(stmt) : ""), exception);
    ct_set_property(ctx, result, "paramsCount", JSValueMakeNumber(ctx, sqlite3_bind_parameter_count(stmt)), exception);
    return result;
}

static JSValueRef ct_sqlite_statement_finalize(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementFinalize(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *stmt = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (stmt != NULL) ct_sqlite_finalize_stmt(stmt);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_statement_all(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementAll(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef rows = ct_make_array(ctx, 0, NULL, exception);
    unsigned row_index = 0;
    bool safe_integers = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    while ((status = sqlite3_step(entry->stmt)) == SQLITE_ROW) {
        JSObjectSetPropertyAtIndex(ctx, rows, row_index++, ct_sqlite_row_object(ctx, entry, safe_integers, exception), exception);
    }
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        sqlite3_reset(entry->stmt);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_reset(entry->stmt);
    return rows;
}

static JSValueRef ct_sqlite_statement_get(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementGet(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    bool safe_integers = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    status = sqlite3_step(entry->stmt);
    if (status == SQLITE_ROW) {
        JSObjectRef row = ct_sqlite_row_object(ctx, entry, safe_integers, exception);
        sqlite3_reset(entry->stmt);
        return row;
    }
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        sqlite3_reset(entry->stmt);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_reset(entry->stmt);
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_statement_values(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementValues(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    JSObjectRef rows = ct_make_array(ctx, 0, NULL, exception);
    unsigned row_index = 0;
    bool safe_integers = argc >= 3 && ct_value_to_bool(ctx, argv[2]);
    while ((status = sqlite3_step(entry->stmt)) == SQLITE_ROW) {
        JSObjectSetPropertyAtIndex(ctx, rows, row_index++, ct_sqlite_row_array(ctx, entry->stmt, safe_integers, exception), exception);
    }
    sqlite3_reset(entry->stmt);
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    return rows;
}

static JSValueRef ct_sqlite_statement_run(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementRun(id[, params]) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int status = ct_sqlite_bind_params(ctx, entry->stmt, argc >= 2 ? argv[1] : NULL, exception);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    status = sqlite3_step(entry->stmt);
    if (status != SQLITE_DONE && status != SQLITE_ROW) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        sqlite3_reset(entry->stmt);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_reset(entry->stmt);
    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "lastInsertRowid", JSValueMakeNumber(ctx, (double)sqlite3_last_insert_rowid(entry->owner->db)), exception);
    ct_set_property(ctx, result, "changes", JSValueMakeNumber(ctx, sqlite3_stmt_readonly(entry->stmt) ? 0 : sqlite3_changes(entry->owner->db)), exception);
    return result;
}

static JSValueRef ct_sqlite_statement_columns(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementColumns(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int count = sqlite3_column_count(entry->stmt);
    JSObjectRef columns = ct_make_array(ctx, 0, NULL, exception);
    ct_set_property(ctx, columns, "readOnly", JSValueMakeBoolean(ctx, sqlite3_stmt_readonly(entry->stmt) != 0), exception);
    for (int index = 0; index < count; index += 1) {
        JSObjectRef column = ct_make_object(ctx);
        const char *name = sqlite3_column_name(entry->stmt, index);
        const char *declared_type = sqlite3_column_decltype(entry->stmt, index);
        const char *table = sqlite3_column_table_name(entry->stmt, index);
        const char *database = sqlite3_column_database_name(entry->stmt, index);
        const char *origin = sqlite3_column_origin_name(entry->stmt, index);
        ct_set_property(ctx, column, "name", ct_make_string(ctx, name != NULL ? name : ""), exception);
        ct_set_property(ctx, column, "type", ct_make_string(ctx, declared_type != NULL ? declared_type : ""), exception);
        ct_set_property(ctx, column, "column", ct_make_string(ctx, origin != NULL ? origin : ""), exception);
        ct_set_property(ctx, column, "table", ct_make_string(ctx, table != NULL ? table : ""), exception);
        ct_set_property(ctx, column, "database", ct_make_string(ctx, database != NULL ? database : ""), exception);
        JSObjectSetPropertyAtIndex(ctx, columns, (unsigned)index, column, exception);
    }
    return columns;
}

static JSValueRef ct_sqlite_statement_expanded_sql(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementExpandedSql(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    char *expanded = sqlite3_expanded_sql(entry->stmt);
    if (expanded == NULL) {
        ct_throw_message(ctx, exception, "Failed to expand SQLite statement");
        return JSValueMakeUndefined(ctx);
    }
    JSValueRef result = ct_make_string(ctx, expanded);
    sqlite3_free(expanded);
    return result;
}

static JSValueRef ct_sqlite_statement_parameter_names(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementParameterNames(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    int count = sqlite3_bind_parameter_count(entry->stmt);
    JSObjectRef names = ct_make_array(ctx, 0, NULL, exception);
    for (int index = 1; index <= count; index += 1) {
        const char *name = sqlite3_bind_parameter_name(entry->stmt, index);
        JSObjectSetPropertyAtIndex(ctx, names, (unsigned)(index - 1), name != NULL ? ct_make_string(ctx, name) : JSValueMakeNull(ctx), exception);
    }
    return names;
}

static const char *ct_sqlite_column_type_name(int type) {
    switch (type) {
        case SQLITE_INTEGER: return "INTEGER";
        case SQLITE_FLOAT: return "FLOAT";
        case SQLITE_TEXT: return "TEXT";
        case SQLITE_BLOB: return "BLOB";
        case SQLITE_NULL:
        default: return "NULL";
    }
}

static JSValueRef ct_sqlite_statement_column_types(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteStatementColumnTypes(id) requires a statement id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteStmt *entry = ct_sqlite_find_stmt((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite statement not found");
        return JSValueMakeUndefined(ctx);
    }
    if (sqlite3_stmt_readonly(entry->stmt) == 0) {
        ct_throw_message(ctx, exception, "columnTypes is not available for non-read-only statements (INSERT, UPDATE, DELETE, etc.)");
        return JSValueMakeUndefined(ctx);
    }

    int status = sqlite3_step(entry->stmt);
    int count = sqlite3_column_count(entry->stmt);
    JSObjectRef types = ct_make_array(ctx, 0, NULL, exception);
    if (status == SQLITE_ROW) {
        for (int index = 0; index < count; index += 1) {
            JSObjectSetPropertyAtIndex(
                ctx,
                types,
                (unsigned)index,
                ct_make_string(ctx, ct_sqlite_column_type_name(sqlite3_column_type(entry->stmt, index))),
                exception
            );
        }
    }
    sqlite3_reset(entry->stmt);
    if (status != SQLITE_ROW && status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, entry->owner->db);
        return JSValueMakeUndefined(ctx);
    }
    return types;
}

static JSValueRef ct_sqlite_in_transaction(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteInTransaction(id) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, sqlite3_get_autocommit(entry->db) == 0);
}

static JSValueRef ct_sqlite_create_function(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 5) {
        ct_throw_message(ctx, exception, "sqliteCreateFunction(id, name, argc, flags, callback) requires five arguments");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *name = ct_value_to_string_copy(ctx, argv[1]);
    if (name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsObject(ctx, argv[4]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[4])) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite function callback must be a function");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteFunction *callback = (CtSqliteFunction *)calloc(1, sizeof(CtSqliteFunction));
    if (callback == NULL) {
        free(name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    callback->ctx = ctx;
    callback->callback = (JSObjectRef)argv[4];
    JSValueProtect(ctx, callback->callback);

    int function_argc = (int)ct_value_to_number(ctx, argv[2]);
    int flags = SQLITE_UTF8 | (int)ct_value_to_number(ctx, argv[3]);
    int status = sqlite3_create_function_v2(
        entry->db,
        name,
        function_argc,
        flags,
        callback,
        ct_sqlite_function_call,
        NULL,
        NULL,
        ct_sqlite_function_destroy
    );
    free(name);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_create_aggregate(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 8) {
        ct_throw_message(ctx, exception, "sqliteCreateAggregate(id, name, argc, flags, start, step, result, inverse) requires eight arguments");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *name = ct_value_to_string_copy(ctx, argv[1]);
    if (name == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsObject(ctx, argv[5]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[5])) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite aggregate step callback must be a function");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsUndefined(ctx, argv[6]) && !JSValueIsNull(ctx, argv[6]) && (!JSValueIsObject(ctx, argv[6]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[6]))) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite aggregate result callback must be a function");
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsUndefined(ctx, argv[7]) && !JSValueIsNull(ctx, argv[7]) && (!JSValueIsObject(ctx, argv[7]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[7]))) {
        free(name);
        ct_throw_message(ctx, exception, "SQLite aggregate inverse callback must be a function");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteFunction *callback = (CtSqliteFunction *)calloc(1, sizeof(CtSqliteFunction));
    if (callback == NULL) {
        free(name);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    callback->ctx = ctx;
    callback->callback = (JSObjectRef)argv[5];
    JSValueProtect(ctx, callback->callback);
    if (JSValueIsObject(ctx, argv[4]) && JSObjectIsFunction(ctx, (JSObjectRef)argv[4])) {
        callback->start_callback = (JSObjectRef)argv[4];
        JSValueProtect(ctx, callback->start_callback);
    } else {
        callback->start_value = argv[4];
        callback->has_start_value = true;
        JSValueProtect(ctx, callback->start_value);
    }
    if (!JSValueIsUndefined(ctx, argv[6]) && !JSValueIsNull(ctx, argv[6])) {
        callback->result_callback = (JSObjectRef)argv[6];
        JSValueProtect(ctx, callback->result_callback);
    }
    if (!JSValueIsUndefined(ctx, argv[7]) && !JSValueIsNull(ctx, argv[7])) {
        callback->inverse_callback = (JSObjectRef)argv[7];
        JSValueProtect(ctx, callback->inverse_callback);
    }

    int function_argc = (int)ct_value_to_number(ctx, argv[2]);
    int flags = SQLITE_UTF8 | (int)ct_value_to_number(ctx, argv[3]);
    int status;
    if (callback->inverse_callback != NULL) {
        status = sqlite3_create_window_function(
            entry->db,
            name,
            function_argc,
            flags,
            callback,
            ct_sqlite_aggregate_step,
            ct_sqlite_aggregate_final,
            ct_sqlite_aggregate_value,
            ct_sqlite_aggregate_inverse,
            ct_sqlite_function_destroy
        );
    } else {
        status = sqlite3_create_function_v2(
            entry->db,
            name,
            function_argc,
            flags,
            callback,
            NULL,
            ct_sqlite_aggregate_step,
            ct_sqlite_aggregate_final,
            ct_sqlite_function_destroy
        );
    }
    free(name);
    if (status != SQLITE_OK) {
        ct_sqlite_function_destroy(callback);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_set_authorizer(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteSetAuthorizer(id, callback) requires database id and callback");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }

    sqlite3_set_authorizer(entry->db, NULL, NULL);
    if (entry->authorizer != NULL) {
        ct_sqlite_function_destroy(entry->authorizer);
        entry->authorizer = NULL;
    }

    if (JSValueIsNull(ctx, argv[1]) || JSValueIsUndefined(ctx, argv[1])) {
        return JSValueMakeUndefined(ctx);
    }
    if (!JSValueIsObject(ctx, argv[1]) || !JSObjectIsFunction(ctx, (JSObjectRef)argv[1])) {
        ct_throw_message(ctx, exception, "SQLite authorizer callback must be a function or null");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteFunction *callback = (CtSqliteFunction *)calloc(1, sizeof(CtSqliteFunction));
    if (callback == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    callback->ctx = ctx;
    callback->callback = (JSObjectRef)argv[1];
    JSValueProtect(ctx, callback->callback);

    int status = sqlite3_set_authorizer(entry->db, ct_sqlite_authorizer_call, callback);
    if (status != SQLITE_OK) {
        ct_sqlite_function_destroy(callback);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    entry->authorizer = callback;
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_enable_load_extension(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteEnableLoadExtension(id, enabled) requires database id and enabled");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    if (!entry->allow_load_extension) {
        ct_throw_message(ctx, exception, "Cannot enable extension loading because it was disabled at database creation.");
        return JSValueMakeUndefined(ctx);
    }

    bool enabled = ct_value_to_bool(ctx, argv[1]);
    CtSqliteEnableLoadExtensionFn enable_load_extension = ct_sqlite_enable_load_extension_fn();
    if (enable_load_extension == NULL) {
        if (enabled) {
            ct_throw_message(ctx, exception, "SQLite extension loading is unavailable in this SQLite build");
            return JSValueMakeUndefined(ctx);
        }
    } else {
        int status = enable_load_extension(entry->db, enabled ? 1 : 0);
        if (status != SQLITE_OK) {
            ct_sqlite_throw(ctx, exception, entry->db);
            return JSValueMakeUndefined(ctx);
        }
    }
    entry->load_extension_enabled = enabled;
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_load_extension(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteLoadExtension(id, path) requires database id and path");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    if (!entry->allow_load_extension || !entry->load_extension_enabled) {
        ct_throw_message(ctx, exception, "extension loading is not allowed");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteLoadExtensionFn load_extension = ct_sqlite_load_extension_fn();
    if (load_extension == NULL) {
        ct_throw_message(ctx, exception, "SQLite extension loading is unavailable in this SQLite build");
        return JSValueMakeUndefined(ctx);
    }

    char *path = ct_value_to_string_copy(ctx, argv[1]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    char *error_message = NULL;
    int status = load_extension(entry->db, path, NULL, &error_message);
    free(path);
    if (status != SQLITE_OK) {
        ct_throw_message(ctx, exception, error_message != NULL ? error_message : sqlite3_errmsg(entry->db));
        sqlite3_free(error_message);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeUndefined(ctx);
}

static JSValueRef ct_sqlite_backup(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteBackup(id, path) requires database id and destination path");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *source = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (source == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *path = ct_value_to_string_copy(ctx, argv[1]);
    if (path == NULL) {
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }

    sqlite3 *destination = NULL;
    int status = sqlite3_open_v2(path, &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_URI, NULL);
    free(path);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, destination);
        if (destination != NULL) sqlite3_close(destination);
        return JSValueMakeUndefined(ctx);
    }

    sqlite3_backup *backup = sqlite3_backup_init(destination, "main", source->db, "main");
    if (backup == NULL) {
        ct_sqlite_throw(ctx, exception, destination);
        sqlite3_close(destination);
        return JSValueMakeUndefined(ctx);
    }
    int pages = 0;
    do {
        status = sqlite3_backup_step(backup, 100);
        pages += 100;
    } while (status == SQLITE_OK || status == SQLITE_BUSY || status == SQLITE_LOCKED);
    int finish_status = sqlite3_backup_finish(backup);
    if (finish_status != SQLITE_OK) status = finish_status;
    if (status != SQLITE_DONE) {
        ct_sqlite_throw(ctx, exception, destination);
        sqlite3_close(destination);
        return JSValueMakeUndefined(ctx);
    }
    sqlite3_close(destination);
    return JSValueMakeNumber(ctx, (double)pages);
}

static JSValueRef ct_sqlite_serialize(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteSerialize(id[, schema]) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }

    char *schema = NULL;
    if (argc >= 2 && !JSValueIsUndefined(ctx, argv[1]) && !JSValueIsNull(ctx, argv[1])) {
        schema = ct_value_to_string_copy(ctx, argv[1]);
        if (schema == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
    }

    sqlite3_int64 size = 0;
    unsigned char *bytes = sqlite3_serialize(entry->db, schema != NULL ? schema : "main", &size, 0);
    free(schema);
    if (bytes == NULL) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }

    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, bytes, (size_t)size, ct_sqlite_array_buffer_free, NULL, exception);
}

static JSValueRef ct_sqlite_file_control(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 3) {
        ct_throw_message(ctx, exception, "sqliteFileControl(id, fileName, op[, result]) requires database id, file name, and op");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }

    char *file_name = NULL;
    if (!JSValueIsUndefined(ctx, argv[1]) && !JSValueIsNull(ctx, argv[1])) {
        file_name = ct_value_to_string_copy(ctx, argv[1]);
        if (file_name == NULL) {
            ct_throw_message(ctx, exception, "Out of memory");
            return JSValueMakeUndefined(ctx);
        }
    }

    int op;
    if (!ct_value_to_int_checked(ctx, argv[2], INT_MIN, INT_MAX, &op, exception, "invalid SQLite file-control operation")) {
        free(file_name);
        return JSValueMakeUndefined(ctx);
    }
    int result_int = -1;
    void *result_ptr = NULL;
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (argc >= 4 && !JSValueIsUndefined(ctx, argv[3]) && !JSValueIsNull(ctx, argv[3])) {
        if (ct_get_bytes(ctx, argv[3], &bytes, &bytes_len) == 0) {
            result_ptr = bytes;
        } else if (JSValueIsNumber(ctx, argv[3])) {
            if (!ct_value_to_int_checked(ctx, argv[3], INT_MIN, INT_MAX, &result_int, exception, "invalid SQLite file-control argument")) {
                free(file_name);
                return JSValueMakeUndefined(ctx);
            }
            result_ptr = &result_int;
        } else {
            free(file_name);
            ct_throw_message(ctx, exception, "sqliteFileControl result must be a number, null, ArrayBuffer, or typed array");
            return JSValueMakeUndefined(ctx);
        }
    }

    int status = sqlite3_file_control(entry->db, file_name, op, result_ptr);
    free(file_name);
    if (status == SQLITE_ERROR) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeNumber(ctx, status);
}

static JSValueRef ct_sqlite_session_create(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteSessionCreate(id[, dbName, table]) requires a database id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    char *db_name = argc >= 2 ? ct_value_to_optional_string(ctx, argv[1]) : NULL;
    char *table = argc >= 3 ? ct_value_to_optional_string(ctx, argv[2]) : NULL;

    sqlite3_session *session = NULL;
    int status = sqlite3session_create(entry->db, db_name != NULL ? db_name : "main", &session);
    free(db_name);
    if (status != SQLITE_OK) {
        free(table);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    status = sqlite3session_attach(session, table);
    free(table);
    if (status != SQLITE_OK) {
        sqlite3session_delete(session);
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteSession *session_entry = (CtSqliteSession *)calloc(1, sizeof(CtSqliteSession));
    if (session_entry == NULL) {
        sqlite3session_delete(session);
        ct_throw_message(ctx, exception, "Out of memory");
        return JSValueMakeUndefined(ctx);
    }
    session_entry->id = ct_next_sqlite_session_id++;
    if (ct_next_sqlite_session_id == 0) ct_next_sqlite_session_id = 1;
    session_entry->session = session;
    session_entry->owner = entry;
    session_entry->next = ct_sqlite_sessions;
    ct_sqlite_sessions = session_entry;
    session_entry->owner_next = entry->sessions;
    entry->sessions = session_entry;

    JSObjectRef result = ct_make_object(ctx);
    ct_set_property(ctx, result, "id", JSValueMakeNumber(ctx, session_entry->id), exception);
    return result;
}

static JSValueRef ct_sqlite_session_changeset(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteSessionChangeset(id, patchset) requires a session id and patchset flag");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteSession *session = ct_sqlite_find_session((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (session == NULL) {
        ct_throw_message(ctx, exception, "SQLite session not found");
        return JSValueMakeUndefined(ctx);
    }
    int byte_len = 0;
    void *bytes = NULL;
    bool patchset = ct_value_to_bool(ctx, argv[1]);
    int status = patchset
        ? sqlite3session_patchset(session->session, &byte_len, &bytes)
        : sqlite3session_changeset(session->session, &byte_len, &bytes);
    if (status != SQLITE_OK) {
        if (bytes != NULL) sqlite3_free(bytes);
        ct_sqlite_throw(ctx, exception, session->owner != NULL ? session->owner->db : NULL);
        return JSValueMakeUndefined(ctx);
    }
    if (bytes == NULL || byte_len <= 0) {
        if (bytes != NULL) sqlite3_free(bytes);
        return ct_array_buffer_from_copy(ctx, "", 0, exception);
    }
    return JSObjectMakeArrayBufferWithBytesNoCopy(ctx, bytes, (size_t)byte_len, ct_sqlite_array_buffer_free, NULL, exception);
}

static JSValueRef ct_sqlite_session_close(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 1) {
        ct_throw_message(ctx, exception, "sqliteSessionClose(id) requires a session id");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteSession *session = ct_sqlite_find_session((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (session != NULL) ct_sqlite_delete_session(session);
    return JSValueMakeUndefined(ctx);
}

static int ct_sqlite_changeset_filter(void *opaque, const char *table) {
    CtSqliteApplyCallbacks *callbacks = (CtSqliteApplyCallbacks *)opaque;
    if (callbacks == NULL || callbacks->filter == NULL) return 1;
    JSValueRef arg = ct_make_string(callbacks->ctx, table != NULL ? table : "");
    JSValueRef call_exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(callbacks->ctx, callbacks->filter, NULL, 1, &arg, &call_exception);
    if (call_exception != NULL) {
        callbacks->error_message = ct_copy_exception(callbacks->ctx, call_exception);
        return 0;
    }
    return ct_value_to_bool(callbacks->ctx, result) ? 1 : 0;
}

static int ct_sqlite_changeset_conflict(void *opaque, int reason, sqlite3_changeset_iter *iterator) {
    (void)iterator;
    CtSqliteApplyCallbacks *callbacks = (CtSqliteApplyCallbacks *)opaque;
    if (callbacks == NULL || callbacks->conflict == NULL) return SQLITE_CHANGESET_ABORT;
    JSValueRef arg = JSValueMakeNumber(callbacks->ctx, reason);
    JSValueRef call_exception = NULL;
    JSValueRef result = JSObjectCallAsFunction(callbacks->ctx, callbacks->conflict, NULL, 1, &arg, &call_exception);
    if (call_exception != NULL) {
        callbacks->error_message = ct_copy_exception(callbacks->ctx, call_exception);
        return SQLITE_CHANGESET_ABORT;
    }
    return (int)ct_value_to_number(callbacks->ctx, result);
}

static JSValueRef ct_sqlite_apply_changeset(JSContextRef ctx, JSObjectRef function, JSObjectRef thisObject, size_t argc, const JSValueRef argv[], JSValueRef *exception) {
    (void)function;
    (void)thisObject;
    if (argc < 2) {
        ct_throw_message(ctx, exception, "sqliteApplyChangeset(id, changeset[, filter, onConflict]) requires database id and changeset");
        return JSValueMakeUndefined(ctx);
    }
    CtSqliteDb *entry = ct_sqlite_find_db((uint32_t)ct_value_to_number(ctx, argv[0]));
    if (entry == NULL) {
        ct_throw_message(ctx, exception, "SQLite database not found");
        return JSValueMakeUndefined(ctx);
    }
    uint8_t *bytes = NULL;
    size_t bytes_len = 0;
    if (ct_get_bytes(ctx, argv[1], &bytes, &bytes_len) != 0 || bytes_len > INT_MAX) {
        ct_throw_message(ctx, exception, "changeset must be an ArrayBuffer or typed array");
        return JSValueMakeUndefined(ctx);
    }

    CtSqliteApplyCallbacks callbacks;
    memset(&callbacks, 0, sizeof(callbacks));
    callbacks.ctx = ctx;
    if (argc >= 3 && JSValueIsObject(ctx, argv[2]) && JSObjectIsFunction(ctx, (JSObjectRef)argv[2])) {
        callbacks.filter = (JSObjectRef)argv[2];
        JSValueProtect(ctx, callbacks.filter);
    }
    if (argc >= 4 && JSValueIsObject(ctx, argv[3]) && JSObjectIsFunction(ctx, (JSObjectRef)argv[3])) {
        callbacks.conflict = (JSObjectRef)argv[3];
        JSValueProtect(ctx, callbacks.conflict);
    }

    int status = sqlite3changeset_apply(
        entry->db,
        (int)bytes_len,
        bytes,
        callbacks.filter != NULL ? ct_sqlite_changeset_filter : NULL,
        ct_sqlite_changeset_conflict,
        &callbacks
    );

    if (callbacks.filter != NULL) JSValueUnprotect(ctx, callbacks.filter);
    if (callbacks.conflict != NULL) JSValueUnprotect(ctx, callbacks.conflict);
    if (callbacks.error_message != NULL) {
        ct_throw_message(ctx, exception, callbacks.error_message);
        free(callbacks.error_message);
        return JSValueMakeUndefined(ctx);
    }
    if (status == SQLITE_ABORT) return JSValueMakeBoolean(ctx, false);
    if (status != SQLITE_OK) {
        ct_sqlite_throw(ctx, exception, entry->db);
        return JSValueMakeUndefined(ctx);
    }
    return JSValueMakeBoolean(ctx, true);
}
