function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class ClassMethod {
  import() {
    return "class";
  }
}

const objectMethod = {
  import(value: string) {
    return value;
  },
};

assert(new ClassMethod()["import"]() === "class", "class method named import was rewritten");
assert(objectMethod.import("object") === "object", "object method named import was rewritten");

const queried = await import("./modules/dep.js?method-regression");
assert(queried.answer === 42, "single-argument dynamic import was not rewritten");

const attributed = await import("./modules/dep.js", { with: { type: "js" } });
assert(attributed.answer === 42, "two-argument dynamic import was not rewritten");

console.log("dynamic import method name passed");
