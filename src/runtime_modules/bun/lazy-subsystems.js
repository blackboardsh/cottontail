import {
  createLazyBuiltin,
  createLazyFunction,
  createLazyModule,
  createLazyObject,
} from "./lazy-runtime.js";

export const loadDNSModule = createLazyModule("bun:dns", () => require("./dns.js"));
export const dns = createLazyObject(loadDNSModule, "dns");

export const loadJSON5Module = createLazyModule("bun:json5", () => require("./json5.js"));
export const JSON5 = createLazyObject(loadJSON5Module, "JSON5");

export const loadTOMLModule = createLazyModule("bun:toml", () => require("./toml.js"));
export const TOML = createLazyObject(loadTOMLModule, "TOML");

export const loadYAMLModule = createLazyModule("bun:yaml", () => require("./yaml.js"));
export const YAML = createLazyObject(
  () => {
    const module = loadYAMLModule();
    return { YAML: module.default ?? module };
  },
  "YAML",
);

export const loadS3Module = createLazyModule("bun:s3", () => require("./s3.js"));
export const S3Client = createLazyFunction(loadS3Module, "S3Client");
export const s3 = createLazyObject(loadS3Module, "s3");

export const loadRedisModule = createLazyModule("bun:redis", () => require("./redis.js"));
export const RedisClient = createLazyFunction(loadRedisModule, "RedisClient");
export const redis = createLazyObject(loadRedisModule, "redis");

export const loadSQLModule = createLazyModule("bun:sql", () => require("./sql.js"));
export const SQL = createLazyFunction(loadSQLModule, "SQL");
export const sql = createLazyFunction(loadSQLModule, "sql");
export const postgres = sql;

export const loadColorModule = createLazyModule("bun:color", () => require("./color.js"));
export const color = createLazyFunction(loadColorModule, "color");

export const loadSocketModule = createLazyModule("bun:socket", () => require("./socket.js"));
export const connect = createLazyFunction(loadSocketModule, "connect");
export const listen = createLazyFunction(loadSocketModule, "listen");

export const loadBunTestModule = createLazyModule("bun:test", () => require("./test.js"));
export const bunTestBuiltin = createLazyBuiltin(
  loadBunTestModule,
  module => module.default ?? module,
);

export const loadBunJSCModule = createLazyModule("bun:jsc", () => require("./jsc.js"));
export const bunJSCBuiltin = createLazyBuiltin(
  loadBunJSCModule,
  module => module.default ?? module,
);

export const loadBunSQLiteModule = createLazyModule("bun:sqlite", () => require("./sqlite.js"));
export const bunSQLiteBuiltin = createLazyBuiltin(loadBunSQLiteModule);

export const loadWebSocketModule = createLazyModule(
  "vendor:ws",
  () => require("../vendor/ws.js"),
);
export const webSocketBuiltin = createLazyBuiltin(
  loadWebSocketModule,
  module => module.default ?? module,
);
