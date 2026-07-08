const outputPath = cottontail.env("COTTONTAIL_DETACHED_OUTPUT");
if (!outputPath) throw new Error("COTTONTAIL_DETACHED_OUTPUT missing");
if (cottontail.existsSync(outputPath)) cottontail.unlinkSync(outputPath);

Bun.spawn(["sh", "-c", `printf detached-ok > ${outputPath}`], {
  detached: true,
});

let output = "";
for (let index = 0; index < 1000; index += 1) {
  globalThis.__cottontailRunLoopTick();
  if (cottontail.existsSync(outputPath)) {
    output = cottontail.readFile(outputPath);
    if (output.length > 0) break;
  }
  cottontail.sleep(1);
}

if (output !== "detached-ok") {
  throw new Error(`detached spawn output mismatch: ${JSON.stringify(output)}`);
}

console.log("spawn detached passed");
