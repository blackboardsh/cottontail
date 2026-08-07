import { join } from "path";

const dir = join(import.meta.dir, "jsx-runtime");
const { default: html } = await import(join(dir, "index.html"));

console.log("html:", html);

const server = Bun.serve({
  port: 0,
  development: true,
  static: {
    "/": html,
  },
  fetch(req) {
    return new Response("Not found", { status: 404 });
  },
});

console.log("server url:", server.url);

try {
  const response = await fetch(server.url);
  console.log("status:", response.status);
  const text = await response.text();
  console.log("body:", text.slice(0, 500));
} catch (e) {
  console.error("fetch failed:", e.message);
}

server.stop();
