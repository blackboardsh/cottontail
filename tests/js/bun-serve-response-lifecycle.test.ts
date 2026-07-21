import { expect, test } from "bun:test";

test("Bun.serve settles rejected request bodies with an empty error response", async () => {
  using server = Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      return new Response();
    },
    error() {
      return new Response(null, { status: 500 });
    },
  });

  for (let index = 0; index < 8; index++) {
    const response = await fetch(`http://127.0.0.1:${server.port}/upload`, {
      body: "invalid json",
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  }

  await Bun.sleep(0);
  expect(server.pendingRequests).toBe(0);
});
