const outputPath = cottontail.env("COTTONTAIL_SERVE_DETACHED_OUTPUT");
if (!outputPath) throw new Error("COTTONTAIL_SERVE_DETACHED_OUTPUT missing");
if (cottontail.existsSync(outputPath)) cottontail.unlinkSync(outputPath);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    return new Response(`served ${new URL(request.url).pathname}`);
  },
});

Bun.spawn(["curl", "-s", "--max-time", "2", "-o", outputPath, new URL("hello", server.url).href], {
  detached: true,
});

let body = "";
for (let index = 0; index < 2000; index += 1) {
  globalThis.__cottontailRunLoopTick();
  if (cottontail.existsSync(outputPath)) {
    body = cottontail.readFile(outputPath);
    if (body.length > 0) break;
  }
  cottontail.sleep(1);
}

await server.stop();

if (body !== "served /hello") {
  throw new Error(`detached serve response mismatch: url=${String(server.url)} body=${JSON.stringify(body)}`);
}

console.log("bun serve detached passed");
