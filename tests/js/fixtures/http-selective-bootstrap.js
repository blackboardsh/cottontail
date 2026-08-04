let server;
server = Bun.serve({
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/request") {
      const clone = request.clone();
      const json = await request.json();
      const cloneText = await clone.text();
      const headers = new Headers(request.headers);
      headers.append("x-copy", "one");
      headers.set("x-copy", `${headers.get("x-copy")}, two`);

      const source = Response.json({ json, cloneText });
      const responseClone = source.clone();
      return Response.json({
        bootstrap: typeof __cottontailHttpServerRuntime !== "undefined" &&
          __cottontailHttpServerRuntime === true,
        requestSignal: request.signal instanceof AbortSignal,
        header: headers.get("x-copy"),
        responseJSON: await source.json(),
        responseCloneText: await responseClone.text(),
      });
    }

    if (pathname === "/form") {
      const parsed = await request.formData();
      const file = parsed.get("empty");
      const responseForm = new FormData();
      responseForm.set("empty", new Blob([]), "response.txt");
      const response = new Response(responseForm);
      const responseClone = response.clone();
      const [first, second] = await Promise.all([response.formData(), responseClone.formData()]);
      return Response.json({
        requestName: file.name,
        requestType: file.type,
        responseName: first.get("empty").name,
        responseType: first.get("empty").type,
        cloneName: second.get("empty").name,
        cloneType: second.get("empty").type,
      });
    }

    return new Response("not found", { status: 404 });
  },
});

process.send({
  url: server.url.href,
  channel: Boolean(process.channel),
  connected: process.connected,
});
