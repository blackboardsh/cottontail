const source = `
source: path.join(import.meta.dir, "test.c"),
const fixture = import("./fixture.js");
`;

const expected = '\nsource: path.join(import.meta.dir, "test.c"),\nconst fixture = import("./fixture.js");\n';
if (source !== expected) {
  throw new Error(`module syntax was rewritten inside a string:\n${source}`);
}

const middlewareId = "\0noop-middleware";
const nestedTemplate = `middleware: ${false ? "undefined" : `() => import("${middlewareId}")`}`;
const expectedNestedTemplate = `middleware: () => import("${middlewareId}")`;
if (nestedTemplate !== expectedNestedTemplate) {
  throw new Error(`module syntax was rewritten inside a nested template:\n${nestedTemplate}`);
}

const nestedImportMeta = `value: ${false ? "undefined" : `() => import.meta.url`}`;
if (nestedImportMeta !== "value: () => import.meta.url") {
  throw new Error(`import.meta was rewritten inside a nested template:\n${nestedImportMeta}`);
}

const importedFromInterpolation = `${(await import("./modules/dep.js?template-interpolation")).answer}`;
if (importedFromInterpolation !== "42") {
  throw new Error(`dynamic import inside a template interpolation was not rewritten`);
}

let importOptionSideEffects = 0;
const importedWithOpaqueOptions = await import(
  "./modules/dep.js?opaque-options",
  (() => {
    importOptionSideEffects++;
    return undefined;
  })()
);
if (importedWithOpaqueOptions.answer !== 42 || importOptionSideEffects !== 1) {
  throw new Error("dynamic import with opaque options was not rewritten");
}

const objectWithImportMethod = { import(value) { return value; } };
if (objectWithImportMethod.import("object") !== "object") {
  throw new Error("object method named import was rewritten");
}

class ClassWithImportMethod {
  import() { return "class"; }
}
if (new ClassWithImportMethod().import() !== "class") {
  throw new Error("class method named import was rewritten");
}

console.log('module syntax string passed');
