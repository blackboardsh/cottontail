import { expect, test } from "bun:test";

test("selective Bun.serve uses the production Request and Response APIs", async () => {
  const ready = Promise.withResolvers();
  const child = Bun.spawn({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/http-selective-bootstrap.js`],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
    ipc(message) {
      ready.resolve(message);
    },
  });

  try {
    const readyMessage = await ready.promise;
    expect(readyMessage.channel).toBe(true);
    expect(readyMessage.connected).toBe(true);
    const url = readyMessage.url;
    const requestResult = await fetch(new URL("/request", url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-original": "yes" },
      body: JSON.stringify({ value: 42 }),
    }).then(response => response.json());
    expect(requestResult).toEqual({
      bootstrap: true,
      requestSignal: true,
      header: "one, two",
      responseJSON: {
        json: { value: 42 },
        cloneText: '{"value":42}',
      },
      responseCloneText: '{"json":{"value":42},"cloneText":"{\\"value\\":42}"}',
    });

    const form = new FormData();
    form.set("empty", new Blob([]), "request.txt");
    const formResult = await fetch(new URL("/form", url), {
      method: "POST",
      body: form,
    }).then(response => response.json());
    expect(formResult).toEqual({
      requestName: "request.txt",
      requestType: "",
      responseName: "response.txt",
      responseType: "",
      cloneName: "response.txt",
      cloneType: "",
    });
  } finally {
    child.kill();
    await child.exited;
  }
});
