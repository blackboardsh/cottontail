function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const proc = Bun.spawn(["sh", "-c", "sleep 0.02; printf async-spawn"], {
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

if (cottontail.platform() !== "win32" && cottontail.spawnSync("curl", ["--version"], { stdio: "pipe" }).status === 0) {
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

  assert(server.url instanceof URL, "Bun.serve url should be a URL");
  assert(String(server.url).startsWith("http://127.0.0.1:"), "Bun.serve url string mismatch");

  const route = Bun.spawn(["curl", "-s", `${server.url}/hello/cottontail`], { stdout: "pipe", stderr: "pipe" });
  assert(route.stdout, "route stdout pipe missing");
  const routeText = await route.stdout.text();
  await route.exited;
  const parsed = JSON.parse(routeText);
  assert(parsed.name === "cottontail", `Bun.serve route params mismatch: ${routeText}`);
  assert(parsed.path === "/hello/cottontail", `Bun.serve route URL mismatch: ${routeText}`);

  const echo = Bun.spawn(["curl", "-s", "-X", "POST", "--data", "posted", `${server.url}/echo`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(echo.stdout, "echo stdout pipe missing");
  assert(await echo.stdout.text() === "posted", "Bun.serve method route mismatch");
  await echo.exited;

  const fallback = await server.fetch(`${server.url}/fallback`);
  assert(await fallback.text() === "/fallback", "Bun.serve server.fetch fallback mismatch");

  await server.stop();
}

console.log("bun serve spawn ts passed");
