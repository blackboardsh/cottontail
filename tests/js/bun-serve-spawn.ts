import { cert, key } from "./fixtures/tls-cert.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectAddressInUse(options: Parameters<typeof Bun.serve>[0], label: string) {
  let duplicate;
  try {
    duplicate = Bun.serve(options);
  } catch (error) {
    assert(
      (error as NodeJS.ErrnoException).code === "EADDRINUSE",
      `${label} error code mismatch: ${String(error)} (code=${String((error as NodeJS.ErrnoException).code)})`,
    );
    return;
  }
  await duplicate.stop(true);
  throw new Error(`${label} duplicate listen unexpectedly succeeded`);
}

const proc = Bun.spawn([
  process.execPath,
  "-e",
  'setTimeout(() => process.stdout.write("async-spawn"), 20)',
], {
  stdout: "pipe",
  stderr: "pipe",
  onExit(subprocess, code: number | null, signal: string | null) {
    assert(subprocess.pid > 0, "Bun.spawn pid missing");
    assert(code === 0, `Bun.spawn onExit code mismatch: ${code}`);
    assert(signal === null, `Bun.spawn onExit signal mismatch: ${signal}`);
  },
});

assert(proc.pid > 0, "Bun.spawn did not return a pid");
assert(proc.stdout, "Bun.spawn stdout pipe missing");
const spawnText = await proc.stdout.text();
const spawnExit = await proc.exited;
assert(spawnText === "async-spawn", `Bun.spawn stdout mismatch: ${JSON.stringify(spawnText)}`);
assert(spawnExit === 0, `Bun.spawn exit mismatch: ${spawnExit}`);
assert(proc.exitCode === 0, "Bun.spawn exitCode getter mismatch");

const childFetchSource = `
const init = JSON.parse(process.argv[2]);
fetch(process.argv[1], init)
  .then(async response => {
    process.stdout.write(await response.text());
    if (!response.ok) process.exitCode = 2;
  })
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
`;

async function fetchFromChild(url: string | URL, init: RequestInit = {}): Promise<string> {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    childFetchSource,
    String(url),
    JSON.stringify(init),
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(child.stdout, "fetch child stdout pipe missing");
  assert(child.stderr, "fetch child stderr pipe missing");
  const [text, errorText, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  assert(exitCode === 0, `fetch child failed (${exitCode}): ${errorText}`);
  return text;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  routes: {
    "/hello/:name": (request: Request) => Response.json({
      name: request.params.name,
      path: new URL(request.url).pathname,
    }),
    "/echo": {
      POST: async (request: Request) => new Response(await request.text(), {
        headers: { "content-type": "text/plain" },
      }),
    },
  },
  fetch(request: Request) {
    return new Response(new URL(request.url).pathname);
  },
});

try {
  assert(server.url instanceof URL, "Bun.serve url should be a URL");
  assert(String(server.url).startsWith("http://127.0.0.1:"), "Bun.serve url string mismatch");
  await expectAddressInUse({
    hostname: "127.0.0.1",
    port: server.port,
    fetch: () => new Response("duplicate"),
  }, "plain Bun.serve");
  await expectAddressInUse({
    hostname: "127.0.0.1",
    port: server.port,
    fetch: () => new Response("duplicate"),
    websocket: {
      message() {},
    },
  }, "websocket Bun.serve");

  const routeText = await fetchFromChild(new URL("/hello/cottontail", server.url));
  const parsed = JSON.parse(routeText);
  assert(parsed.name === "cottontail", `Bun.serve route params mismatch: ${routeText}`);
  assert(parsed.path === "/hello/cottontail", `Bun.serve route URL mismatch: ${routeText}`);

  const echoText = await fetchFromChild(new URL("/echo", server.url), {
    method: "POST",
    body: "posted",
  });
  assert(echoText === "posted", "Bun.serve method route mismatch");

  const fallback = await server.fetch(new URL("/fallback", server.url).href);
  assert(await fallback.text() === "/fallback", "Bun.serve server.fetch fallback mismatch");
} finally {
  await server.stop();
}

const tlsServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert, key },
  fetch: () => new Response("secure"),
});
try {
  await expectAddressInUse({
    hostname: "127.0.0.1",
    port: tlsServer.port,
    tls: { cert, key },
    fetch: () => new Response("duplicate"),
  }, "TLS Bun.serve");
} finally {
  await tlsServer.stop();
}

console.log("bun serve spawn ts passed");
