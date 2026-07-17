import assert from "node:assert/strict";

const { internalBinding } = require("internal/test/binding");

class DummyParser {
  initializedWith: unknown;

  initialize(type: unknown) {
    this.initializedWith = type;
  }
}

(DummyParser as any).REQUEST = Symbol("request");
const binding = internalBinding("http_parser");
binding.HTTPParser = DummyParser;

const common = require("_http_common");
const parser = common.parsers.alloc();
parser.initialize((DummyParser as any).REQUEST, {});

assert.strictEqual(common.HTTPParser, DummyParser);
assert.ok(parser instanceof DummyParser);
assert.strictEqual(parser.initializedWith, (DummyParser as any).REQUEST);
console.log("node _http_common lazy load passed");
