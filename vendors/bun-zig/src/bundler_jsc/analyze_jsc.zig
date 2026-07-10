//! JSC bridge for analyze_transpiled_module.zig — converts the parsed
//! `ModuleInfoDeserialized` into a `JSC::JSModuleRecord`. Aliased back so the
//! `export fn` symbol names are still discoverable from C++.

export fn zig__renderDiff(expected_ptr: [*:0]const u8, expected_len: usize, received_ptr: [*:0]const u8, received_len: usize, globalThis: *bun.jsc.JSGlobalObject) void {
    const formatter = DiffFormatter{
        .received_string = received_ptr[0..received_len],
        .expected_string = expected_ptr[0..expected_len],
        .globalThis = globalThis,
    };
    bun.Output.errorWriter().print("DIFF:\n{any}\n", .{formatter}) catch {};
}

export fn zig__ModuleInfoDeserialized__toJSModuleRecord(
    globalObject: *bun.jsc.JSGlobalObject,
    vm: *bun.jsc.VM,
    module_key: *const IdentifierArray,
    source_code: *const SourceCode,
    declared_variables: *VariableEnvironment,
    lexical_variables: *VariableEnvironment,
    res: *ModuleInfoDeserialized,
) ?*JSModuleRecord {
    _ = globalObject;
    _ = vm;
    _ = module_key;
    _ = source_code;
    _ = declared_variables;
    _ = lexical_variables;
    _ = res;
    return null;
}

const VariableEnvironment = opaque {
    extern fn JSC__VariableEnvironment__add(environment: *VariableEnvironment, vm: *bun.jsc.VM, identifier_array: *IdentifierArray, identifier_index: StringID) void;
    pub const add = JSC__VariableEnvironment__add;
};
const IdentifierArray = opaque {
    extern fn JSC__IdentifierArray__create(len: usize) *IdentifierArray;
    pub const create = JSC__IdentifierArray__create;

    extern fn JSC__IdentifierArray__destroy(identifier_array: *IdentifierArray) void;
    pub const destroy = JSC__IdentifierArray__destroy;

    extern fn JSC__IdentifierArray__setFromUtf8(identifier_array: *IdentifierArray, n: usize, vm: *bun.jsc.VM, str: [*]const u8, len: usize) void;
    pub fn setFromUtf8(self: *IdentifierArray, n: usize, vm: *bun.jsc.VM, str: []const u8) void {
        JSC__IdentifierArray__setFromUtf8(self, n, vm, str.ptr, str.len);
    }
};
const SourceCode = opaque {};
const JSModuleRecord = opaque {
    extern fn JSC_JSModuleRecord__create(global_object: *bun.jsc.JSGlobalObject, vm: *bun.jsc.VM, module_key: *const IdentifierArray, source_code: *const SourceCode, declared_variables: *VariableEnvironment, lexical_variables: *VariableEnvironment, has_import_meta: bool, is_typescript: bool, has_tla: bool) *JSModuleRecord;
    pub const create = JSC_JSModuleRecord__create;

    extern fn JSC_JSModuleRecord__declaredVariables(module_record: *JSModuleRecord) *VariableEnvironment;
    pub const declaredVariables = JSC_JSModuleRecord__declaredVariables;
    extern fn JSC_JSModuleRecord__lexicalVariables(module_record: *JSModuleRecord) *VariableEnvironment;
    pub const lexicalVariables = JSC_JSModuleRecord__lexicalVariables;

    extern fn JSC_JSModuleRecord__addIndirectExport(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, export_name: StringID, import_name: StringID, module_name: StringID) void;
    pub const addIndirectExport = JSC_JSModuleRecord__addIndirectExport;
    extern fn JSC_JSModuleRecord__addLocalExport(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, export_name: StringID, local_name: StringID) void;
    pub const addLocalExport = JSC_JSModuleRecord__addLocalExport;
    extern fn JSC_JSModuleRecord__addNamespaceExport(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, export_name: StringID, module_name: StringID) void;
    pub const addNamespaceExport = JSC_JSModuleRecord__addNamespaceExport;
    extern fn JSC_JSModuleRecord__addStarExport(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, module_name: StringID) void;
    pub const addStarExport = JSC_JSModuleRecord__addStarExport;

    extern fn JSC_JSModuleRecord__addRequestedModuleNullAttributesPtr(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, module_name: StringID) void;
    pub const addRequestedModuleNullAttributesPtr = JSC_JSModuleRecord__addRequestedModuleNullAttributesPtr;
    extern fn JSC_JSModuleRecord__addRequestedModuleJavaScript(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, module_name: StringID) void;
    pub const addRequestedModuleJavaScript = JSC_JSModuleRecord__addRequestedModuleJavaScript;
    extern fn JSC_JSModuleRecord__addRequestedModuleWebAssembly(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, module_name: StringID) void;
    pub const addRequestedModuleWebAssembly = JSC_JSModuleRecord__addRequestedModuleWebAssembly;
    extern fn JSC_JSModuleRecord__addRequestedModuleJSON(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, module_name: StringID) void;
    pub const addRequestedModuleJSON = JSC_JSModuleRecord__addRequestedModuleJSON;
    extern fn JSC_JSModuleRecord__addRequestedModuleHostDefined(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, module_name: StringID, host_defined_import_type: StringID) void;
    pub const addRequestedModuleHostDefined = JSC_JSModuleRecord__addRequestedModuleHostDefined;

    extern fn JSC_JSModuleRecord__addImportEntrySingle(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, import_name: StringID, local_name: StringID, module_name: StringID) void;
    pub const addImportEntrySingle = JSC_JSModuleRecord__addImportEntrySingle;
    extern fn JSC_JSModuleRecord__addImportEntrySingleTypeScript(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, import_name: StringID, local_name: StringID, module_name: StringID) void;
    pub const addImportEntrySingleTypeScript = JSC_JSModuleRecord__addImportEntrySingleTypeScript;
    extern fn JSC_JSModuleRecord__addImportEntryNamespace(module_record: *JSModuleRecord, identifier_array: *IdentifierArray, import_name: StringID, local_name: StringID, module_name: StringID) void;
    pub const addImportEntryNamespace = JSC_JSModuleRecord__addImportEntryNamespace;
};

const bun = @import("bun");
const DiffFormatter = @import("../test_runner/diff_format.zig").DiffFormatter;

const analyze = @import("../bundler/analyze_transpiled_module.zig");
const ModuleInfoDeserialized = analyze.ModuleInfoDeserialized;
const StringID = analyze.StringID;
