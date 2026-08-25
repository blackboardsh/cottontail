import { createLazyFunction } from "../bun/lazy-runtime.js";
import { loadCottontailCapabilityModule } from "../node/module.js";
import EventEmitter from "node:events";
import { Buffer } from "node:buffer";
import { Duplex } from "node:stream";
import * as http from "node:http";

cottontail.__cottontailWebSocketHostModules ??= { EventEmitter, Buffer, Duplex, http };

const state = globalThis[Symbol.for("cottontail.capabilityFacade.websocket.ws")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("websocket", "vendor/ws.js");
const lazy = name => state.exports[name] ??= createLazyFunction(load, name);

export const WebSocketServer = lazy("WebSocketServer");
export const Server = lazy("Server");
export const Sender = lazy("Sender");
export const Receiver = lazy("Receiver");
export const createWebSocketStream = lazy("createWebSocketStream");

const surface = { WebSocketServer, Server, Sender, Receiver, createWebSocketStream };
const target = function WebSocket(...args) {
  return Reflect.construct(load().WebSocket, args, load().WebSocket);
};
export const WebSocket = state.module ??= new Proxy(target, {
  apply(_target, receiver, args) {
    return Reflect.apply(load().WebSocket, receiver, args);
  },
  construct(_target, args, newTarget) {
    const constructor = load().WebSocket;
    return Reflect.construct(constructor, args, newTarget === WebSocket ? constructor : newTarget);
  },
  get(_target, property) {
    if (property === "WebSocket") return WebSocket;
    if (Object.prototype.hasOwnProperty.call(surface, property)) return surface[property];
    const implementation = load().WebSocket;
    return Reflect.get(implementation, property, implementation);
  },
  getOwnPropertyDescriptor(_target, property) {
    if (property === "WebSocket") {
      return { value: WebSocket, writable: true, enumerable: true, configurable: true };
    }
    if (Object.prototype.hasOwnProperty.call(surface, property)) {
      return { value: surface[property], writable: true, enumerable: true, configurable: true };
    }
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
  has(_target, property) {
    return property === "WebSocket" || Object.prototype.hasOwnProperty.call(surface, property) || property in load().WebSocket;
  },
  ownKeys() {
    return [...new Set([...Reflect.ownKeys(target), "WebSocket", ...Reflect.ownKeys(surface)])];
  },
});

export default WebSocket;
