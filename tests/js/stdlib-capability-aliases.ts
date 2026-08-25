import * as ffiImport from "bun:ffi";
import * as sqliteImport from "bun:sqlite";
import * as yamlImport from "bun:yaml";
import * as sqlImport from "bun:sql";
import * as zlibImport from "node:zlib";
import * as jscImport from "bun:jsc";

const ffiRequire = require("bun:ffi");
const sqliteRequire = require("bun:sqlite");
const yamlRequire = require("bun:yaml");
const sqlRequire = require("bun:sql");
const zlibRequire = require("node:zlib");
const jscRequire = require("bun:jsc");

if (ffiImport.FFIType !== ffiRequire.FFIType) throw new Error("FFI alias cache mismatch");
if (sqliteImport.Database !== sqliteRequire.Database) throw new Error("SQLite alias cache mismatch");
if (yamlImport.parse !== yamlRequire.parse) throw new Error("YAML alias cache mismatch");
if (sqlImport.SQL !== sqlRequire.SQL) throw new Error("SQL alias cache mismatch");
if (zlibImport.createGzip !== zlibRequire.createGzip) throw new Error("zlib ESM/CommonJS alias cache mismatch");
if (jscImport.heapStats !== jscRequire.heapStats) throw new Error("bun:jsc ESM/CommonJS alias cache mismatch");
if (typeof Cottontail.bun.ffi.FFIType !== "object") throw new Error("Cottontail.bun.ffi activation mismatch");
if (typeof Cottontail.bun.sqlite.Database !== "function") throw new Error("Cottontail.bun.sqlite activation mismatch");
if (typeof Cottontail.bun.yaml.parse !== "function") throw new Error("Cottontail.bun.yaml activation mismatch");
if (typeof Cottontail.bun.sql.SQL !== "function") throw new Error("Cottontail.bun.sql activation mismatch");
if (typeof Cottontail.node.zlib.createGzip !== "function") throw new Error("Cottontail.node.zlib activation mismatch");
if (typeof Cottontail.bun.jsc.heapStats !== "function") throw new Error("Cottontail.bun.jsc activation mismatch");
if (yamlRequire.parse("answer: 42").answer !== 42) throw new Error("YAML parse mismatch");

const database = new sqliteRequire.Database(":memory:");
if (database.query("select 42 as answer").get().answer !== 42) throw new Error("SQLite query mismatch");
database.close();
