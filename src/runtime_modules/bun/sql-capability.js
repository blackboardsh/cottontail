// Use the capability instance shared by the runtime module loader.
const namespace = globalThis.Cottontail.sql;
export const { SQL, sql, postgres, MySQLError, PostgresError, SQLError } = namespace;
