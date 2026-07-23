import SQLiteDefault, { Database, SQLiteError, constants } from "bun:sqlite";
import { createRequire } from "node:module";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(SQLiteDefault === Database, "bun:sqlite default export mismatch");
const require = createRequire(import.meta.url);
assert(require("bun:sqlite").default === Database, "bun:sqlite require default mismatch");

const db = new Database(":memory:");
assert(db.filename === ":memory:", "bun:sqlite filename mismatch");
assert(constants.SQLITE_OPEN_READWRITE === 2, "bun:sqlite constants mismatch");
assert(db.inTransaction === false, "bun:sqlite initial inTransaction mismatch");

db.run("create table users (id integer primary key, name text not null)");
const insert = db.run("insert into users (name) values (?)", "Ada");
assert(insert.changes === 1, "bun:sqlite insert changes mismatch");
assert(insert.lastInsertRowid === 1, "bun:sqlite lastInsertRowid mismatch");

const statement = db.query("select id, name from users where name = ?");
assert(db.query("select id, name from users where name = ?") === statement, "bun:sqlite query cache mismatch");
assert(statement.paramsCount === 1, "bun:sqlite paramsCount mismatch");
assert(JSON.stringify(statement.columnNames) === JSON.stringify(["id", "name"]), "bun:sqlite columnNames mismatch");
assert(JSON.stringify(statement.values("Ada")) === JSON.stringify([[1, "Ada"]]), "bun:sqlite values mismatch");
assert(statement.get("Ada")?.name === "Ada", "bun:sqlite get mismatch");
assert(statement.all("Ada").length === 1, "bun:sqlite all mismatch");
assert([...statement.iterate("Ada")][0].id === 1, "bun:sqlite iterate mismatch");
assert(JSON.stringify(statement.native.columns) === JSON.stringify(["id", "name"]), "bun:sqlite native columns mismatch");
assert(statement.native.columnsCount === 2, "bun:sqlite native column count mismatch");
assert(JSON.stringify(statement.columnTypes) === JSON.stringify(["INTEGER", "TEXT"]), "bun:sqlite runtime column types mismatch");
assert(JSON.stringify(statement.declaredTypes) === JSON.stringify(["INTEGER", "TEXT"]), "bun:sqlite declared column types mismatch");
assert(statement.safeIntegers() === false, "bun:sqlite safeIntegers default mismatch");
statement.safeIntegers(true);
assert(typeof statement.get("Ada")?.id === "bigint", "bun:sqlite safeIntegers read mismatch");
statement.safeIntegers(false);

class User {
  id = 0;
  name = "";
}

const shaped = db.prepare("select id, name from users").as(User).get();
assert(shaped instanceof User && shaped.name === "Ada", "bun:sqlite Statement.as mismatch");
assert(db.prepare("select id from users where id = -1").get() === null, "bun:sqlite missing row should be null");
assert(db.prepare("select x'DEADBEEF' as blob").get()?.blob instanceof Uint8Array, "bun:sqlite blob shape mismatch");

const expanded = db.prepare("select $value as value");
assert(expanded.toString() === "select NULL as value", "bun:sqlite initial expanded SQL mismatch");
expanded.get({ $value: "cottontail" });
assert(expanded.toString() === "select 'cottontail' as value", "bun:sqlite bound expanded SQL mismatch");
expanded[Symbol.dispose]();
assert(expanded.isFinalized, "bun:sqlite statement disposal mismatch");

const transaction = db.transaction((name: string) => {
  assert(db.inTransaction === true, "bun:sqlite transaction did not enter transaction");
  db.run("insert into users (name) values (?)", name);
  return db.query("select count(*) as count from users").get()?.count;
});
assert(transaction("Grace") === 2, "bun:sqlite transaction result mismatch");

const serialized = db.serialize();
assert(serialized instanceof Uint8Array && serialized.byteLength > 0, "bun:sqlite serialize mismatch");
assert(typeof db.fileControl(constants.SQLITE_FCNTL_LOCKSTATE, new Int32Array(1)) === "number", "bun:sqlite fileControl mismatch");

let failed = false;
try {
  db.prepare("select from").all();
} catch (error) {
  failed = error instanceof SQLiteError || (error as Error).name === "SQLiteError";
}
assert(failed, "bun:sqlite SQLiteError mismatch");

statement.finalize();
db.close();
console.log("bun sqlite passed");
