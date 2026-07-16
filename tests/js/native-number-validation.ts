import { throws } from "node:assert/strict";

throws(() => cottontail.fdWatchStart(Number.NaN), /invalid file descriptor/);
throws(() => cottontail.fdWatchStart(0, Number.NaN), /invalid maximum byte count/);
throws(() => cottontail.fdWatchStop(Number.NaN), /invalid file descriptor watcher id/);
throws(() => cottontail.closeFd(Number.NaN), /invalid file descriptor/);
throws(() => cottontail.processInfo("setuid", Number.NaN), /invalid user id/);
throws(() => cottontail.processInfo("initgroups", "nobody", Number.NaN), /invalid extra group id/);
throws(() => cottontail.chmodSync(".", Number.NaN), /invalid file mode/);
throws(() => cottontail.chownSync(".", Number.NaN, 0, true), /invalid user id/);

const sqliteId = cottontail.sqliteOpen(":memory:", 0).id;
throws(() => cottontail.sqliteFileControl(sqliteId, null, Number.NaN, null), /invalid SQLite file-control operation/);
cottontail.sqliteClose(sqliteId);

console.log("native number validation passed");
