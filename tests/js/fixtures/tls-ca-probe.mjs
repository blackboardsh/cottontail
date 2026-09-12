import { readFileSync } from "node:fs";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

export async function probeConnections(config) {
  const url = new URL(config.url);
  const ca = config.caFile ? readFileSync(config.caFile, "utf8") : config.emptyCA ? [] : undefined;
  const servername = config.servername ?? (isIP(url.hostname) ? "" : url.hostname);
  const options = { ca, servername };
  const fetchTLS = config.caFile || config.emptyCA || config.servername
    ? { ca, serverName: config.servername }
    : undefined;
  const attempts = {
    tls: () => new Promise((resolve, reject) => {
      const socket = tls.connect({
        ...options,
        host: url.hostname,
        port: Number(url.port || 443),
      }, () => {
        const authorized = socket.authorized;
        socket.destroy();
        if (authorized) resolve("verified");
        else reject(new Error("TLS connection was not authorized"));
      });
      socket.once("error", reject);
      socket.setTimeout(8000, () => socket.destroy(new Error("TLS probe timed out")));
    }),
    https: () => new Promise((resolve, reject) => {
      const request = https.get(config.url, { ...options, agent: false }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
        response.once("error", reject);
      });
      request.once("error", reject);
      request.setTimeout(8000, () => request.destroy(new Error("HTTPS probe timed out")));
    }),
    fetch: async () => {
      const response = await fetch(config.url, {
        tls: fetchTLS,
        signal: AbortSignal.timeout(8000),
        keepalive: false,
      });
      await response.text();
      return response.status;
    },
  };
  const results = {};
  for (const [name, attempt] of Object.entries(attempts)) {
    try {
      results[name] = { ok: true, value: await attempt() };
    } catch (error) {
      results[name] = { ok: false, code: error.code, message: error.message };
    }
  }
  return results;
}

if (import.meta.main) {
  const config = JSON.parse(process.argv[2]);
  const main = await probeConnections(config);
  const worker = new Worker(fileURLToPath(new URL("./tls-ca-worker.mjs", import.meta.url)), { type: "module" });
  const threaded = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("TLS worker probe timed out")), 30000);
    worker.onmessage = event => {
      clearTimeout(timeout);
      resolve(event.data);
    };
    worker.onerror = event => {
      clearTimeout(timeout);
      reject(new Error(event.message));
    };
    worker.postMessage(config);
  });
  worker.terminate();
  console.log(JSON.stringify({ main, worker: threaded }));
}
