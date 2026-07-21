using server = Bun.serve({
  port: 0,
  fetch() {
    throw new Error("focused HTTP handler failure");
  },
});

await fetch(server.url);
