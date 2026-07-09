import {
  Agent as HttpAgent,
  Server as HttpServer,
  createServer as createHttpServer,
  request as httpRequest,
  get as httpGet,
} from "./http.js";

export class Agent extends HttpAgent {}

export class Server extends HttpServer {
  listen(..._args) {
    throw new Error("https.Server requires native TLS bindings in Cottontail");
  }
}

export const globalAgent = new Agent({ protocol: "https:" });

export function request(input, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  return httpRequest(input, { ...(options ?? {}), protocol: "https:" }, callback);
}

export function get(input, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  return httpGet(input, { ...(options ?? {}), protocol: "https:" }, callback);
}

export function createServer(_options = {}, _requestListener = undefined) {
  throw new Error("https.createServer requires native TLS bindings in Cottontail");
}

// Keep an internal reference so bundlers do not erase the HTTP server import when users inspect the class.
createHttpServer;

// COTTONTAIL-COMPAT: node:https TLS server - HTTPS client requests use fetch; TLS server creation needs native TLS bindings.

export default {
  Agent,
  Server,
  createServer,
  get,
  globalAgent,
  request,
};
