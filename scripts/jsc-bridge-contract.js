export const jscBridgeFunctionNames = Object.freeze([
  'JSBigIntCreateWithInt64',
  'JSBigIntCreateWithUInt64',
  'JSClassCreate',
  'JSClassRelease',
  'JSContextGetGlobalObject',
  'JSObjectCallAsConstructor',
  'JSObjectCallAsFunction',
  'JSObjectGetArrayBufferByteLength',
  'JSObjectGetArrayBufferBytesPtr',
  'JSObjectGetPrivate',
  'JSObjectGetProperty',
  'JSObjectGetPropertyAtIndex',
  'JSObjectGetTypedArrayBuffer',
  'JSObjectGetTypedArrayByteLength',
  'JSObjectGetTypedArrayByteOffset',
  'JSObjectGetTypedArrayBytesPtr',
  'JSObjectIsFunction',
  'JSObjectMake',
  'JSObjectMakeArray',
  'JSObjectMakeArrayBufferWithBytesNoCopy',
  'JSObjectMakeError',
  'JSObjectMakeTypedArray',
  'JSObjectMakeTypedArrayWithArrayBuffer',
  'JSObjectSetPrivate',
  'JSObjectSetProperty',
  'JSObjectSetPropertyAtIndex',
  'JSStringCreateWithCharacters',
  'JSStringCreateWithUTF8CString',
  'JSStringGetCharactersPtr',
  'JSStringGetLength',
  'JSStringGetMaximumUTF8CStringSize',
  'JSStringGetUTF8CString',
  'JSStringRelease',
  'JSValueGetTypedArrayType',
  'JSValueIsBigInt',
  'JSValueIsBoolean',
  'JSValueIsInstanceOfConstructor',
  'JSValueIsNull',
  'JSValueIsNumber',
  'JSValueIsObject',
  'JSValueIsObjectOfClass',
  'JSValueIsString',
  'JSValueIsUndefined',
  'JSValueMakeBoolean',
  'JSValueMakeNull',
  'JSValueMakeNumber',
  'JSValueMakeString',
  'JSValueMakeUndefined',
  'JSValueProtect',
  'JSValueToBoolean',
  'JSValueToNumber',
  'JSValueToStringCopy',
  'JSValueUnprotect',
]);

export function stockJscBridgeSymbols(symbolPrefix = '') {
  return [
    ...jscBridgeFunctionNames.map((name) => `${symbolPrefix}${name}`),
    `${symbolPrefix}kJSClassDefinitionEmpty`,
  ];
}

export function namespacedJscBridgeSymbols(symbolPrefix = '') {
  return [
    ...jscBridgeFunctionNames.map((name) => `${symbolPrefix}cottontail_jsc_${name}`),
    `${symbolPrefix}cottontail_jsc_get_class_definition_empty`,
  ];
}

export function assertNamespacedJscBridgeExports(
  exportedSymbols,
  { symbolPrefix = '', label = 'export set' } = {},
) {
  const exportedSet = new Set(exportedSymbols);
  const leaked = stockJscBridgeSymbols(symbolPrefix).filter((name) => exportedSet.has(name));
  if (leaked.length > 0) {
    throw new Error(`${label} exposes stock JSC symbols: ${leaked.join(', ')}`);
  }

  const missing = namespacedJscBridgeSymbols(symbolPrefix)
    .filter((name) => !exportedSet.has(name));
  if (missing.length > 0) {
    throw new Error(`${label} is missing Cottontail JSC bridge symbols: ${missing.join(', ')}`);
  }
}
