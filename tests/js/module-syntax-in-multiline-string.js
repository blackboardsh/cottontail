const source = `
source: path.join(import.meta.dir, "test.c"),
const fixture = import("./fixture.js");
`;

const expected = '\nsource: path.join(import.meta.dir, "test.c"),\nconst fixture = import("./fixture.js");\n';
if (source !== expected) {
  throw new Error(`module syntax was rewritten inside a string:\n${source}`);
}

console.log('module syntax string passed');
