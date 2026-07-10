import { ok, strictEqual, throws } from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync, Session, StatementSync, backup, constants } from "node:sqlite";

const require = createRequire(import.meta.url);
const requiredSqlite = require("node:sqlite");

strictEqual(requiredSqlite.DatabaseSync, DatabaseSync, "require node:sqlite DatabaseSync mismatch");
strictEqual(requiredSqlite.Session, Session, "require node:sqlite Session mismatch");
strictEqual(requiredSqlite.StatementSync, StatementSync, "require node:sqlite StatementSync mismatch");
strictEqual(requiredSqlite.backup, backup, "require node:sqlite backup mismatch");
strictEqual(constants.SQLITE_OK, 0, "sqlite constants SQLITE_OK mismatch");
strictEqual(constants.SQLITE_INSERT, 18, "sqlite constants SQLITE_INSERT mismatch");

const db = new DatabaseSync(":memory:");
strictEqual(typeof Session, "function", "sqlite Session should be exported");
strictEqual(db.open, true, "DatabaseSync should start open");
strictEqual(db.location, ":memory:", "DatabaseSync location mismatch");

db.exec(`
  create table items (
    id integer primary key,
    name text not null,
    price real,
    payload blob
  );
`);

const insert = db.prepare("insert into items(name, price, payload) values (?, ?, ?)");
strictEqual(insert instanceof StatementSync, true, "prepare should return StatementSync");
const firstRun = insert.run("alpha", 1.5, new Uint8Array([1, 2, 3]));
strictEqual(firstRun.lastInsertRowid, 1, "insert lastInsertRowid mismatch");
strictEqual(firstRun.changes, 1, "insert changes mismatch");

const namedInsert = db.prepare("insert into items(name, price, payload) values ($name, $price, $payload)");
const secondRun = namedInsert.run({ $name: "beta", $price: 2.25, $payload: Buffer.from([4, 5]) });
strictEqual(secondRun.lastInsertRowid, 2, "named insert lastInsertRowid mismatch");

const all = db.prepare("select id, name, price, payload from items where id > ? order by id").all(0);
strictEqual(all.length, 2, "select all row count mismatch");
strictEqual(all[0].name, "alpha", "select all text mismatch");
strictEqual(all[0].price, 1.5, "select all number mismatch");
strictEqual(Buffer.from(all[0].payload).toString("hex"), "010203", "select all blob mismatch");

const get = db.prepare("select name from items where id = ?").get(2);
strictEqual(get.name, "beta", "select get mismatch");
strictEqual(db.prepare("select name from items where id = ?").get(99), undefined, "select get no row mismatch");

const iterated = Array.from(db.prepare("select name from items order by id").iterate()).map((row) => row.name);
strictEqual(iterated.join(","), "alpha,beta", "iterate mismatch");

const tagStore = db.createTagStore(2);
strictEqual(tagStore.capacity, 2, "SQLTagStore capacity mismatch");
const tagRun = tagStore.run`insert into items(name, price, payload) values (${"gamma"}, ${3.5}, ${Buffer.from([6])})`;
strictEqual(tagRun.lastInsertRowid, 3, "SQLTagStore run lastInsertRowid mismatch");
strictEqual(tagStore.get`select name from items where id = ${3}`.name, "gamma", "SQLTagStore get mismatch");
strictEqual(tagStore.all`select name from items where id > ${1} order by id`.length, 2, "SQLTagStore all mismatch");
strictEqual(Array.from(tagStore.iterate`select name from items order by id`).map((row) => row.name).join(","), "alpha,beta,gamma", "SQLTagStore iterate mismatch");
ok(tagStore.size() <= 2, "SQLTagStore should respect capacity");
tagStore.clear();
strictEqual(tagStore.size(), 0, "SQLTagStore clear mismatch");

const uncachedTagStore = db.createTagStore(0);
strictEqual(uncachedTagStore.get`select name from items where id = ${1}`.name, "alpha", "uncached SQLTagStore get mismatch");
strictEqual(uncachedTagStore.size(), 0, "uncached SQLTagStore size mismatch");

strictEqual(db.function("add_one", (value) => Number(value) + 1), undefined, "DatabaseSync.function should return undefined");
strictEqual(db.prepare("select add_one(41) as value").get().value, 42, "SQLite scalar function number result mismatch");

db.function("concat_pair", { deterministic: true }, (left, right) => `${left}:${right}`);
strictEqual(db.prepare("select concat_pair('a', 'b') as value").get().value, "a:b", "SQLite scalar function string result mismatch");

db.function("sum_all", { varargs: true }, (...values) => values.reduce((sum, value) => sum + Number(value), 0));
strictEqual(db.prepare("select sum_all(1, 2, 3, 4) as value").get().value, 10, "SQLite scalar varargs function mismatch");

db.function("return_null", () => null);
strictEqual(db.prepare("select return_null() as value").get().value, null, "SQLite scalar null result mismatch");

db.function("return_blob", () => Buffer.from([7, 8, 9]));
strictEqual(Buffer.from(db.prepare("select return_blob() as value").get().value).toString("hex"), "070809", "SQLite scalar blob result mismatch");
throws(() => db.function("too_many_args", { arguments: 128 }, () => null), RangeError, "SQLite scalar function should validate argument count");

strictEqual(
  db.aggregate("sum_prices", {
    start: 0,
    step: (acc, price) => acc + Number(price),
    result: (acc) => Math.round(acc * 100) / 100,
  }),
  undefined,
  "DatabaseSync.aggregate should return undefined",
);
strictEqual(db.prepare("select sum_prices(price) as value from items").get().value, 7.25, "SQLite aggregate sum mismatch");

let aggregateStarts = 0;
db.aggregate("bucket_sum", {
  start: () => {
    aggregateStarts += 1;
    return 0;
  },
  step: (acc, price) => acc + Number(price),
});
const groupedTotals = db.prepare("select price > 2 as bucket, bucket_sum(price) as total from items group by bucket order by bucket").all();
strictEqual(aggregateStarts, 2, "SQLite aggregate start factory should run once per group");
strictEqual(groupedTotals[0].total, 1.5, "SQLite grouped aggregate false bucket mismatch");
strictEqual(groupedTotals[1].total, 5.75, "SQLite grouped aggregate true bucket mismatch");

db.aggregate("join_names", {
  start: "",
  varargs: true,
  step: (acc, name, separator) => (acc ? `${acc}${separator}${name}` : String(name)),
});
strictEqual(db.prepare("select join_names(name, '|') as value from items").get().value, "alpha|beta|gamma", "SQLite aggregate varargs mismatch");

db.aggregate("object_sum", {
  start: () => ({ total: 0 }),
  step: (acc, price) => {
    acc.total += Number(price);
    return acc;
  },
  result: (acc) => acc.total,
});
strictEqual(db.prepare("select object_sum(price) as value from items").get().value, 7.25, "SQLite aggregate object accumulator mismatch");

db.aggregate("empty_start", {
  start: 5,
  step: (acc, price) => acc + Number(price),
  result: (acc) => acc * 2,
});
strictEqual(db.prepare("select empty_start(price) as value from items where id < 0").get().value, 10, "SQLite aggregate empty input mismatch");
db.aggregate("moving_sum", {
  start: 0,
  step: (acc, price) => acc + Number(price),
  inverse: (acc, price) => acc - Number(price),
  result: (acc) => Math.round(acc * 100) / 100,
});
const movingTotals = db.prepare("select id, moving_sum(price) over (order by id rows between 1 preceding and current row) as total from items order by id").all();
strictEqual(movingTotals[0].total, 1.5, "SQLite window aggregate first row mismatch");
strictEqual(movingTotals[1].total, 3.75, "SQLite window aggregate second row mismatch");
strictEqual(movingTotals[2].total, 5.75, "SQLite window aggregate inverse mismatch");
db.aggregate("throw_window_inverse", {
  start: 0,
  step: (acc, price) => acc + Number(price),
  inverse: () => {
    throw new Error("sqlite inverse boom");
  },
  result: (acc) => acc,
});
throws(() => db.prepare("select throw_window_inverse(price) over (order by id rows between 1 preceding and current row) from items").all(), /sqlite inverse boom/, "SQLite window inverse thrown error mismatch");
db.aggregate("throw_aggregate_step", {
  start: 0,
  step: (_acc, _price) => {
    throw new Error("sqlite aggregate boom");
  },
});
throws(() => db.prepare("select throw_aggregate_step(price) from items").get(), /sqlite aggregate boom/, "SQLite aggregate thrown error mismatch");

const authorizerCalls: Array<[number, string | null, string | null, string | null, string | null]> = [];
db.setAuthorizer((actionCode, arg1, arg2, databaseName, triggerOrView) => {
  authorizerCalls.push([actionCode, arg1, arg2, databaseName, triggerOrView]);
  if (actionCode === constants.SQLITE_READ && arg2 === "price") return constants.SQLITE_IGNORE;
  return constants.SQLITE_OK;
});
strictEqual(db.prepare("select price from items where id = 1").get().price, null, "SQLite authorizer IGNORE read mismatch");
ok(authorizerCalls.some(([code, table]) => code === constants.SQLITE_SELECT || table === "items"), "SQLite authorizer should receive query actions");
db.setAuthorizer((actionCode, arg1) => {
  if (actionCode === constants.SQLITE_DELETE && arg1 === "items") return constants.SQLITE_DENY;
  return constants.SQLITE_OK;
});
throws(() => db.prepare("delete from items where id = 3").run(), /not authorized|authorization/i, "SQLite authorizer DENY mismatch");
db.setAuthorizer(null);
strictEqual(db.prepare("delete from items where id = 99").run().changes, 0, "SQLite authorizer clear mismatch");

db.function("throw_js", () => {
  throw new Error("sqlite callback boom");
});
try {
  db.prepare("select throw_js()").get();
  throw new Error("throw_js should fail");
} catch (error) {
  ok(String(error).includes("sqlite callback boom"), "SQLite scalar thrown error mismatch");
}

const columns = db.prepare("select id, name from items").columns();
ok(columns.some((column) => column.name === "id"), "columns should include id");
ok(columns.some((column) => column.name === "name"), "columns should include name");

throws(() => db.enableLoadExtension(true), /disabled at database creation/, "SQLite extension loading should require constructor opt-in");
throws(() => db.loadExtension("/definitely/missing/cottontail-ext"), /not allowed/, "SQLite loadExtension should be disabled by default");
const extensionDb = new DatabaseSync(":memory:", { allowExtension: true });
strictEqual(extensionDb.enableLoadExtension(false), undefined, "SQLite enableLoadExtension(false) mismatch");
throws(() => extensionDb.loadExtension("/definitely/missing/cottontail-ext"), /not allowed/, "SQLite loadExtension disabled state mismatch");
let nativeExtensionLoading = true;
try {
  extensionDb.enableLoadExtension(true);
} catch (error) {
  nativeExtensionLoading = false;
  ok(String(error).includes("unavailable"), "SQLite enableLoadExtension(true) unavailable error mismatch");
}
if (nativeExtensionLoading) {
  throws(() => extensionDb.loadExtension("/definitely/missing/cottontail-ext"), /missing|not found|cannot open|dlopen|No such file/i, "SQLite loadExtension should call native loader when enabled");
} else {
  throws(() => extensionDb.loadExtension("/definitely/missing/cottontail-ext"), /unavailable|not allowed/, "SQLite loadExtension unavailable build mismatch");
}
extensionDb.close();

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
if (!tmpDir) throw new Error("COTTONTAIL_TMP_DIR is required");
const backupPath = join(tmpDir, "cottontail-node-sqlite-backup.db");
const backedUpPages = await backup(db, backupPath);
ok(backedUpPages > 0, "backup should report copied pages");

const backupDb = new DatabaseSync(backupPath);
strictEqual(backupDb.prepare("select count(*) as count from items").get().count, 3, "backup row count mismatch");
backupDb.close();

try {
  new Session();
  throw new Error("Session should require sqlite session extension support");
} catch (error) {
  ok(String((error as Error).message).includes("session extension"), "Session unsupported error mismatch");
}

db.close();
strictEqual(db.open, false, "DatabaseSync should close");

console.log("node sqlite surface passed");
