import { serve } from "bun";

let server = Bun.serve({
  port: 0,
  development: {
    hmr: false,
  },
  async fetch(req) {
    return new Response("Hello World", {
      status: 404,
    });
  },
});

process.on("message", async message => {
  if (message?.type !== "configure") return;
  const files = message.files || {};
  const routes = {};
  for (const [key, value] of Object.entries(files)) {
    routes[key] = (await import(value)).default;
  }

  server.reload({
    // omit "fetch" to check we can do server.reload without passing fetch
    static: routes,
    development: {
      hmr: false,
    },
  });

  process.send({ type: "routes-ready" });
});

process.send({
  type: "listening",
  port: server.port,
  hostname: server.hostname,
});
