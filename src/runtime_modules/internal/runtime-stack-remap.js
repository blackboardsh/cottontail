import { remapErrorPosition, remapPosition, remapStackString, sourceContextForLocation } from "../vendor/sourcemap.js";

globalThis.__cottontailRemapStackString ??= remapStackString;
globalThis.__cottontailSourceContextForLocation ??= sourceContextForLocation;
globalThis.__cottontailRemapPosition ??= remapPosition;

// Error.line/.column/.originalLine/.originalColumn must map bundled positions
// back to source even in bare `run` mode, where the full Bun runtime module
// (bun/index.js) — which installs the rich Node-style error constructors — is
// never loaded. This installs a *light* constructor wrapper that only performs
// the source-map position remap (lazily, so the ~200ms map parse is never paid
// at construction). When bun/index.js does load (bun:test mode), its richer
// installer unwraps this layer via __cottontailOriginalError and wraps the
// original constructor instead, so there is never a double remap.
function installErrorPositionRemap(error) {
  const generatedPosition = {
    line: Number(error.line),
    column: Number(error.column),
    sourceURL: error.sourceURL,
  };
  let positionComputed = false;
  const applyMappedPosition = () => {
    if (positionComputed) return;
    positionComputed = true;
    let mappedPosition = null;
    try {
      mappedPosition = remapErrorPosition(generatedPosition.line, generatedPosition.column);
    } catch {}
    Object.defineProperties(error, {
      line: { configurable: true, writable: true, value: mappedPosition?.line ?? generatedPosition.line },
      column: { configurable: true, writable: true, value: mappedPosition?.column ?? generatedPosition.column },
      originalLine: { configurable: true, writable: true, value: mappedPosition?.originalLine },
      originalColumn: { configurable: true, writable: true, value: mappedPosition?.originalColumn },
      sourceURL: { configurable: true, writable: true, value: mappedPosition?.source ?? generatedPosition.sourceURL },
    });
  };
  for (const property of ["line", "column", "originalLine", "originalColumn", "sourceURL"]) {
    Object.defineProperty(error, property, {
      configurable: true,
      enumerable: false,
      get() {
        applyMappedPosition();
        return error[property];
      },
      set(value) {
        applyMappedPosition();
        error[property] = value;
      },
    });
  }
}

function installLightErrorConstructor(name) {
  const NativeError = globalThis[name];
  if (typeof NativeError !== "function") return;
  // Already wrapped, by either this light layer or bun/index.js's rich layer.
  if (NativeError.__cottontailStackHeader || NativeError.__cottontailLightError) return;
  const CottontailLightError = function(...args) {
    const error = Reflect.construct(NativeError, args, new.target || CottontailLightError);
    installErrorPositionRemap(error);
    return error;
  };
  Object.defineProperty(CottontailLightError, "name", { value: name });
  Object.defineProperty(CottontailLightError, "__cottontailLightError", { value: true });
  Object.defineProperty(CottontailLightError, "__cottontailOriginalError", { value: NativeError });
  Object.setPrototypeOf(CottontailLightError, NativeError);
  CottontailLightError.prototype = NativeError.prototype;
  globalThis[name] = CottontailLightError;
}

for (const errorName of ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"]) {
  installLightErrorConstructor(errorName);
}
