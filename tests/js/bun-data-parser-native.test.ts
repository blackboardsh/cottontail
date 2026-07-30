import { JSON5, TOML, YAML } from "bun";
import { describe, expect, test } from "bun:test";

describe("Bun data parser conformance", () => {
  test("native binding is installed", () => {
    expect(typeof globalThis.cottontail?.yamlParseNative).toBe("function");
  });

  test("JSON5 preserves nested values and exact number forms", () => {
    const result = JSON5.parse(`{
      title: 'native',
      nested: { enabled: true, nil: null },
      values: [-0, Infinity, -Infinity, NaN, 0xff],
      nul: '\\0',
    }`);
    expect(result.title).toBe("native");
    expect(result.nested).toEqual({ enabled: true, nil: null });
    expect(Object.is(result.values[0], -0)).toBe(true);
    expect(result.values.slice(1, 3)).toEqual([Infinity, -Infinity]);
    expect(result.values[3]).toBeNaN();
    expect(result.values[4]).toBe(255);
    expect(result.nul).toBe("\0");
  });

  test("TOML preserves tables, arrays of tables, and inline tables", () => {
    const result = TOML.parse(`
name = "cottontail"
ports = [3000, 3001]
inline = { nested = { enabled = true } }

[[workers]]
name = "one"

[[workers]]
name = "two"
`);
    expect(result).toEqual({
      name: "cottontail",
      ports: [3000, 3001],
      inline: { nested: { enabled: true } },
      workers: [{ name: "one" }, { name: "two" }],
    });
  });

  test("YAML preserves aliases and applies merge keys", () => {
    const aliases = YAML.parse(`
shared: &shared
  value: 42
first: *shared
second: *shared
`);
    expect(aliases.first).toBe(aliases.shared);
    expect(aliases.second).toBe(aliases.shared);

    const merged = YAML.parse(`
defaults: &defaults
  host: localhost
  port: 5432
development:
  <<: *defaults
  port: 5433
`);
    expect(merged.development).toEqual({ host: "localhost", port: 5433 });
  });

  test("YAML returns every document in a multi-document stream", () => {
    expect(YAML.parse(`
---
document: 1
---
document: 2
`)).toEqual([{ document: 1 }, { document: 2 }]);
  });

  test("YAML document markers are only recognized at line starts", () => {
    for (const value of ["hi ... hello", { message: "hi ... hello" }]) {
      const encoded = YAML.stringify(value);
      expect(YAML.parse(encoded)).toEqual(value);
    }
  });

  test("typed inputs retain the public coercion behavior", () => {
    expect(JSON5.parse(new TextEncoder().encode("{answer: 42}"))).toEqual({ answer: 42 });
    expect(TOML.parse(new TextEncoder().encode("answer = 42"))).toEqual({ answer: 42 });
    expect(YAML.parse(new TextEncoder().encode("answer: 42"))).toEqual({ answer: 42 });
  });

  test("parse errors use public error classes and prefixes", () => {
    expect(() => JSON5.parse("{")).toThrow(SyntaxError);
    expect(() => JSON5.parse("{")).toThrow("JSON5 Parse error");
    expect(() => YAML.parse("[")).toThrow(SyntaxError);
    expect(() => YAML.parse("[")).toThrow("YAML Parse error");
    expect(() => TOML.parse("a = {")).toThrow();
  });
});
