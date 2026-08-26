#define SQLITE_ENABLE_SESSION 1
#define SQLITE_ENABLE_PREUPDATE_HOOK 1
#include "sqlite3_local.h"
#include "../jsc_bridge.h"
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct CtSqliteStmt CtSqliteStmt;
typedef struct CtSqliteSession CtSqliteSession;
typedef struct CtSqliteFunction CtSqliteFunction;
typedef int (*CtSqliteEnableLoadExtensionFn)(sqlite3 *, int);
typedef int (*CtSqliteLoadExtensionFn)(sqlite3 *, const char *, const char *, char **);
typedef struct CtSqliteDb {
    uint32_t id; sqlite3 *db; CtSqliteStmt *statements; CtSqliteSession *sessions;
    CtSqliteFunction *authorizer; bool allow_load_extension; bool load_extension_enabled;
    struct CtSqliteDb *next;
} CtSqliteDb;
struct CtSqliteStmt {
    uint32_t id; sqlite3_stmt *stmt; CtSqliteDb *owner; CtSqliteStmt *owner_next; CtSqliteStmt *next;
    JSStringRef *column_names; int column_count;
};
struct CtSqliteSession { uint32_t id; sqlite3_session *session; CtSqliteDb *owner; CtSqliteSession *owner_next; CtSqliteSession *next; };
struct CtSqliteFunction {
    JSContextRef ctx; JSObjectRef callback; JSObjectRef result_callback; JSObjectRef start_callback;
    JSObjectRef inverse_callback; JSValueRef start_value; bool has_start_value;
};
typedef struct CtSqliteAggregateState { bool initialized; JSValueRef accumulator; char *error_message; } CtSqliteAggregateState;
typedef struct CtSqliteApplyCallbacks { JSContextRef ctx; JSObjectRef filter; JSObjectRef conflict; char *error_message; } CtSqliteApplyCallbacks;

static CtSqliteDb *ct_sqlite_dbs;
static CtSqliteStmt *ct_sqlite_stmts;
static CtSqliteSession *ct_sqlite_sessions;
static uint32_t ct_next_sqlite_db_id = 1, ct_next_sqlite_stmt_id = 1, ct_next_sqlite_session_id = 1;

static char *ct_duplicate_bytes(const char *bytes, size_t len) { char *v=malloc(len+1); if(!v)return NULL; memcpy(v,bytes,len); v[len]=0; return v; }
static char *ct_value_to_string_copy(JSContextRef c, JSValueRef v) { JSValueRef e=NULL; JSStringRef s=JSValueToStringCopy(c,v,&e); if(!s)return NULL; size_t n=JSStringGetMaximumUTF8CStringSize(s); char *r=malloc(n?n:1); if(r)JSStringGetUTF8CString(s,r,n); JSStringRelease(s); return r; }
static char *ct_copy_exception(JSContextRef c, JSValueRef v) { return ct_value_to_string_copy(c,v); }
static JSValueRef ct_make_string_len(JSContextRef c,const char *v,size_t n){ JSStringRef s=JSStringCreateWithUTF8CString(v?v:""); (void)n; JSValueRef r=JSValueMakeString(c,s); JSStringRelease(s); return r; }
static JSValueRef ct_make_string(JSContextRef c,const char *v){ return ct_make_string_len(c,v,v?strlen(v):0); }
static void ct_throw_message(JSContextRef c,JSValueRef *e,const char *m){ if(e)*e=ct_make_string(c,m); }
static bool ct_set_property(JSContextRef c,JSObjectRef o,const char *n,JSValueRef v,JSValueRef *e){ JSStringRef s=JSStringCreateWithUTF8CString(n); JSObjectSetProperty(c,o,s,v,kJSPropertyAttributeNone,e); JSStringRelease(s); return !e||!*e; }
static JSValueRef ct_get_property(JSContextRef c,JSObjectRef o,const char *n,JSValueRef *e){ JSStringRef s=JSStringCreateWithUTF8CString(n); JSValueRef r=JSObjectGetProperty(c,o,s,e); JSStringRelease(s); return r; }
static bool ct_value_to_bool(JSContextRef c,JSValueRef v){ return JSValueToBoolean(c,v); }
static double ct_value_to_number(JSContextRef c,JSValueRef v){ JSValueRef e=NULL; double r=JSValueToNumber(c,v,&e); return e?0:r; }
static bool ct_value_to_int_checked(JSContextRef c,JSValueRef v,int min,int max,int *r,JSValueRef *e,const char *m){ double n=JSValueToNumber(c,v,e); if((e&&*e)||!isfinite(n)||n<min||n>max){if(!e||!*e)ct_throw_message(c,e,m);return false;}*r=(int)n;return true;}
static char *ct_value_to_optional_string(JSContextRef c,JSValueRef v){ return !v||JSValueIsUndefined(c,v)||JSValueIsNull(c,v)?NULL:ct_value_to_string_copy(c,v); }
static JSObjectRef ct_make_object(JSContextRef c){ return JSObjectMake(c,NULL,NULL); }
static JSObjectRef ct_make_array(JSContextRef c,size_t n,const JSValueRef v[],JSValueRef *e){ return JSObjectMakeArray(c,n,v,e); }
static void ct_array_buffer_free(void *p,void *x){(void)x;free(p);} static void ct_sqlite_array_buffer_free(void *p,void *x){(void)x;sqlite3_free(p);}
static JSValueRef ct_array_buffer_from_copy(JSContextRef c,const char *b,size_t n,JSValueRef *e){void *p=malloc(n?n:1);if(!p){ct_throw_message(c,e,"Out of memory");return JSValueMakeUndefined(c);}if(n)memcpy(p,b,n);return JSObjectMakeArrayBufferWithBytesNoCopy(c,p,n,ct_array_buffer_free,NULL,e);}
static JSValueRef ct_uint8_array_from_copy(JSContextRef c,const char *b,size_t n,JSValueRef *e){JSObjectRef a=(JSObjectRef)ct_array_buffer_from_copy(c,b,n,e);if((e&&*e)||!a)return JSValueMakeUndefined(c);return JSObjectMakeTypedArrayWithArrayBuffer(c,kJSTypedArrayTypeUint8Array,a,e);}
static int ct_get_bytes(JSContextRef c,JSValueRef v,uint8_t **p,size_t *n){*p=NULL;*n=0;if(!JSValueIsObject(c,v))return -1;JSValueRef e=NULL;JSObjectRef o=(JSObjectRef)v;JSTypedArrayType t=JSValueGetTypedArrayType(c,v,&e);if(e)return -1;if(t==kJSTypedArrayTypeArrayBuffer){*p=JSObjectGetArrayBufferBytesPtr(c,o,&e);*n=JSObjectGetArrayBufferByteLength(c,o,&e);return e?-1:0;}if(t!=kJSTypedArrayTypeNone){size_t x=JSObjectGetTypedArrayByteOffset(c,o,&e);*n=JSObjectGetTypedArrayByteLength(c,o,&e);JSObjectRef a=JSObjectGetTypedArrayBuffer(c,o,&e);uint8_t *b=a?JSObjectGetArrayBufferBytesPtr(c,a,&e):NULL;if(e)return -1;*p=b?b+x:NULL;return 0;}return -1;}

#include "sqlite_implementation.inc"

#define CT_NATIVE_BINDING(name, callback) { name, callback },
static const struct { const char *name; JSObjectCallAsFunctionCallback callback; } bindings[] = {
#include "../../native_bindings/sqlite.inc"
};
#undef CT_NATIVE_BINDING

#if defined(_WIN32)
__declspec(dllexport)
#else
__attribute__((visibility("default")))
#endif
int cottontail_capability_init(JSContextRef context, JSObjectRef target) {
    for (size_t i=0;i<sizeof(bindings)/sizeof(bindings[0]);i++) {
        JSClassDefinition d=kJSClassDefinitionEmpty; d.className=bindings[i].name; d.callAsFunction=bindings[i].callback;
        JSClassRef cls=JSClassCreate(&d); JSObjectRef fn=JSObjectMake(context,cls,NULL); JSClassRelease(cls);
        JSStringRef key=JSStringCreateWithUTF8CString(bindings[i].name); JSValueRef error=NULL;
        JSObjectSetProperty(context,target,key,fn,kJSPropertyAttributeNone,&error); JSStringRelease(key);
        if(error)return -1;
    }
    return 0;
}
