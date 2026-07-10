import { Database, SQLiteError, constants } from "bun:sqlite";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

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
