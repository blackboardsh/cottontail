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

const requestUrl = new URL("/hello", server.url).href;
Bun.spawn([
  process.execPath,
  "-e",
  "fetch(process.argv[1]).then(async response => require('node:fs').writeFileSync(process.argv[2], await response.text())).catch(error => { console.error(error); process.exitCode = 1; })",
  requestUrl,
  outputPath,
], {
  detached: true,
});

let body = "";
const deadline = Date.now() + 15_000;
while (Date.now() < deadline) {
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
