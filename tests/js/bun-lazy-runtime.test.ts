import { expect, test } from "bun:test";

const lazyDiagnosticsSymbol = "cottontail.runtime.lazyModules";
const optionalModules = [
  "bun:dns",
  "bun:json5",
  "bun:toml",
  "bun:yaml",
  "bun:s3",
  "bun:redis",
  "bun:sql",
  "bun:color",
  "bun:socket",
  "bun:test",
  "bun:jsc",
  "bun:sqlite",
  "vendor:ws",
  "vendor:picomatch",
  "internal:bun-shell-parser",
  "bun:bake-framework-router",
  "bun:bake-dev-server",
];
const lazyBunProperties = [
  "JSON5",
  "RedisClient",
  "S3Client",
  "SQL",
  "TOML",
  "YAML",
  "color",
  "connect",
  "dns",
  "listen",
  "postgres",
  "redis",
  "s3",
  "sql",
];

function runRuntime(source: string) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", source],
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      COTTONTAIL_LAZY_RUNTIME_DIAGNOSTICS: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(String(result.stderr)).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(String(result.stdout).trim());
}

test("full Bun bootstrap leaves optional subsystems uninitialized", () => {
  const result = runRuntime(`
    import {
      JSON5, RedisClient, S3Client, SQL, TOML, YAML, color, connect, dns,
      listen, postgres, redis, s3, sql,
    } from "bun";

    const names = ${JSON.stringify(optionalModules)};
    const statuses = globalThis[Symbol.for(${JSON.stringify(lazyDiagnosticsSymbol)})];
    const descriptors = Object.fromEntries(${JSON.stringify(lazyBunProperties)}
      .map(name => {
        const descriptor = Object.getOwnPropertyDescriptor(Bun, name);
        return [name, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          hasGetter: "get" in descriptor,
          writable: descriptor.writable,
        }];
      }));

    console.log(JSON.stringify({
      descriptors,
      identities: {
        JSON5: JSON5 === Bun.JSON5,
        RedisClient: RedisClient === Bun.RedisClient,
        S3Client: S3Client === Bun.S3Client,
        SQL: SQL === Bun.SQL,
        TOML: TOML === Bun.TOML,
        YAML: YAML === Bun.YAML,
        color: color === Bun.color,
        connect: connect === Bun.connect,
        dns: dns === Bun.dns,
        listen: listen === Bun.listen,
        postgres: postgres === Bun.postgres,
        redis: redis === Bun.redis,
        s3: s3 === Bun.s3,
        sql: sql === Bun.sql,
      },
      statuses: Object.fromEntries(names.map(name => [name, statuses?.get(name)])),
      types: {
        fetch: typeof fetch,
        response: typeof Response,
        sql: typeof Bun.SQL,
      },
      wsRegistrations: ["ws", "ws/lib/websocket", "next/dist/compiled/ws"].map(name => {
        const value = globalThis.__cottontailBuiltinModules?.get(name);
        return value?.[Symbol.for("cottontail.lazyBuiltin")] === true;
      }),
    }));
  `);

  expect(result.types).toEqual({
    fetch: "function",
    response: "function",
    sql: "function",
  });
  expect(Object.values(result.identities).every(Boolean)).toBe(true);
  expect(Object.values(result.statuses).every(value => value === false)).toBe(true);
  expect(result.wsRegistrations).toEqual([true, true, true]);

  for (const descriptor of Object.values(result.descriptors) as Array<Record<string, boolean>>) {
    expect(descriptor).toEqual({
      configurable: true,
      enumerable: true,
      hasGetter: false,
      writable: true,
    });
  }
});

test("first use initializes once and preserves callable and constructor behavior", () => {
  const result = runRuntime(`
    import {
      JSON5, RedisClient, S3Client, SQL, YAML, color, connect, dns, listen,
    } from "bun";

    const before = Object.fromEntries(
      globalThis[Symbol.for(${JSON.stringify(lazyDiagnosticsSymbol)})],
    );
    const parsedJSON5 = JSON5.parse("{ answer: 42 }");
    const parsedYAML = YAML.parse("answer: 43");
    const s3Client = new S3Client({ region: "us-east-1" });
    const redisClient = new RedisClient("redis://127.0.0.1:6379");
    const sqlName = SQL.name;
    const sqlError = SQL.SQLError;
    const values = {
      color: color("red", "hex"),
      connect: connect.name,
      dns: dns.ADDRCONFIG,
      listen: listen.name,
    };
    const after = Object.fromEntries(
      globalThis[Symbol.for(${JSON.stringify(lazyDiagnosticsSymbol)})],
    );

    console.log(JSON.stringify({
      after,
      before,
      descriptors: ["SQL", "S3Client", "RedisClient"].map(name =>
        Object.getOwnPropertyDescriptor(Bun, name)),
      identities: {
        RedisClient: RedisClient === Bun.RedisClient,
        S3Client: S3Client === Bun.S3Client,
        SQL: SQL === Bun.SQL,
      },
      instances: {
        redisConstructor: redisClient.constructor === RedisClient,
        redis: redisClient instanceof RedisClient,
        redisDefault: Bun.redis instanceof RedisClient,
        s3Constructor: s3Client.constructor === S3Client,
        s3: s3Client instanceof S3Client,
        s3Default: Bun.s3 instanceof S3Client,
      },
      parsedJSON5,
      parsedYAML,
      sqlError: typeof sqlError,
      sqlName,
      values,
    }));
  `);

  expect(result.before["bun:sql"]).toBe(false);
  expect(result.before["bun:s3"]).toBe(false);
  expect(result.before["bun:redis"]).toBe(false);
  for (const name of [
    "bun:json5",
    "bun:yaml",
    "bun:s3",
    "bun:redis",
    "bun:sql",
    "bun:color",
    "bun:socket",
    "bun:dns",
  ]) {
    expect(result.after[name]).toBe(true);
  }
  expect(result.identities).toEqual({
    RedisClient: true,
    S3Client: true,
    SQL: true,
  });
  expect(result.instances).toEqual({
    redisConstructor: true,
    redis: true,
    redisDefault: true,
    s3Constructor: true,
    s3: true,
    s3Default: true,
  });
  expect(result.parsedJSON5).toEqual({ answer: 42 });
  expect(result.parsedYAML).toEqual({ answer: 43 });
  expect(result.sqlName).toBe("SQL");
  expect(result.sqlError).toBe("function");
  expect(result.values).toEqual({
    color: "#ff0000",
    connect: "connect",
    dns: expect.any(Number),
    listen: "listen",
  });
  for (const descriptor of result.descriptors) {
    expect(descriptor).toMatchObject({
      configurable: true,
      enumerable: true,
      writable: true,
    });
    expect(descriptor.get).toBeUndefined();
  }
});

test("test globals reify to the exact bun:test exports", () => {
  const result = runRuntime(`
    const status = globalThis[Symbol.for(${JSON.stringify(lazyDiagnosticsSymbol)})];
    const before = {
      descriptor: Object.getOwnPropertyDescriptor(globalThis, "test"),
      loaded: status.get("bun:test"),
    };
    const globalTest = globalThis.test;
    const testModule = require("bun:test");
    const afterDescriptor = Object.getOwnPropertyDescriptor(globalThis, "test");

    console.log(JSON.stringify({
      afterDescriptor: {
        configurable: afterDescriptor.configurable,
        enumerable: afterDescriptor.enumerable,
        hasGetter: "get" in afterDescriptor,
        writable: afterDescriptor.writable,
      },
      before: {
        configurable: before.descriptor.configurable,
        enumerable: before.descriptor.enumerable,
        hasGetter: "get" in before.descriptor,
        loaded: before.loaded,
      },
      identity: globalTest === testModule.test,
      loaded: status.get("bun:test"),
    }));
  `);

  expect(result.before).toEqual({
    configurable: true,
    enumerable: true,
    hasGetter: true,
    loaded: false,
  });
  expect(result.afterDescriptor).toEqual({
    configurable: true,
    enumerable: true,
    hasGetter: false,
    writable: true,
  });
  expect(result.identity).toBe(true);
  expect(result.loaded).toBe(true);
});

test("lazy builtin registrations load the exact public modules", () => {
  const result = runRuntime(`
    const status = globalThis[Symbol.for(${JSON.stringify(lazyDiagnosticsSymbol)})];
    const builtins = globalThis.__cottontailBuiltinModules;
    const wsLoaders = [
      builtins.get("ws"),
      builtins.get("ws/lib/websocket"),
      builtins.get("next/dist/compiled/ws"),
    ];
    const before = {
      jsc: status.get("bun:jsc"),
      sqlite: status.get("bun:sqlite"),
      ws: status.get("vendor:ws"),
    };
    const jsc = require("bun:jsc");
    const sqlite = require("bun:sqlite");
    const ws = wsLoaders[0]();

    console.log(JSON.stringify({
      before,
      identities: {
        wsAliases: wsLoaders.every(loader => loader === wsLoaders[0]),
        wsRequire: require("ws") === ws,
      },
      loaded: {
        jsc: status.get("bun:jsc"),
        sqlite: status.get("bun:sqlite"),
        ws: status.get("vendor:ws"),
      },
      types: {
        heapStats: typeof jsc.heapStats,
        sqlite: typeof sqlite.Database,
        webSocketServer: typeof ws.WebSocketServer,
      },
    }));
  `);

  expect(result.before).toEqual({
    jsc: false,
    sqlite: false,
    ws: false,
  });
  expect(result.loaded).toEqual({
    jsc: true,
    sqlite: true,
    ws: true,
  });
  expect(result.identities).toEqual({
    wsAliases: true,
    wsRequire: true,
  });
  expect(result.types).toEqual({
    heapStats: "function",
    sqlite: "function",
    webSocketServer: "function",
  });
});
