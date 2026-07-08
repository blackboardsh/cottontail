const outputPath = `${cottontail.cwd()}/.cottontail-tmp/spawn-active-handle.txt`;

cottontail.rmSync(outputPath, false, true);

Bun.spawn(["sh", "-c", "sleep 0.02; printf active-handle > \"$1\"", "sh", outputPath], {
  stdout: "ignore",
  stderr: "pipe",
});
