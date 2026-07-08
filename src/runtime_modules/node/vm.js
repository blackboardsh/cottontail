export function createContext(context = {}) {
  return context;
}

export function isContext(value) {
  return value != null && typeof value === "object";
}

export function runInThisContext(code) {
  return (0, eval)(String(code));
}

export function runInContext(code, context = {}) {
  return Function("context", `with (context) { return (${String(code)}); }`)(context);
}

export class Script {
  constructor(code) {
    this.code = String(code);
  }

  runInThisContext() {
    return runInThisContext(this.code);
  }

  runInContext(context) {
    return runInContext(this.code, context);
  }
}

export default { Script, createContext, isContext, runInContext, runInThisContext };
