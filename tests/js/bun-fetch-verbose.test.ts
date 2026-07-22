import { expect, test } from "bun:test";

test("curl verbose fetch includes a prepared URLSearchParams body", async () => {
  const previousMode = process.env.BUN_CONFIG_VERBOSE_FETCH;
  const originalWrite = process.stderr.write;
  const diagnostics: string[] = [];
  process.env.BUN_CONFIG_VERBOSE_FETCH = "curl";
  process.stderr.write = ((chunk: unknown) => {
    diagnostics.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "abc",
      client_secret: "xyz",
    });
    const response = await fetch(String(server.url), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(await response.text()).toBe("ok");
  } finally {
    await server.stop();
    process.stderr.write = originalWrite;
    if (previousMode === undefined) delete process.env.BUN_CONFIG_VERBOSE_FETCH;
    else process.env.BUN_CONFIG_VERBOSE_FETCH = previousMode;
  }

  expect(diagnostics.join("")).toContain(
    '--data-raw "grant_type=client_credentials&client_id=abc&client_secret=xyz"',
  );
});
