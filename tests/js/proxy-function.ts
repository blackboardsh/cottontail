const target = function request(method: string, params?: unknown) {
  return `${method}:${String(params)}`;
};

const request = new Proxy(target, {
  get(proxyTarget, prop, receiver) {
    if (prop in proxyTarget) {
      return Reflect.get(proxyTarget, prop, receiver);
    }
    return (params?: unknown) => proxyTarget(String(prop), params);
  },
});

if (typeof request !== "function") {
  throw new Error(`request proxy type mismatch: ${typeof request}`);
}

if (typeof request.getMachineConnectionStatus !== "function") {
  throw new Error(
    `request method type mismatch: ${typeof request.getMachineConnectionStatus}`,
  );
}

if (request.getMachineConnectionStatus("x") !== "getMachineConnectionStatus:x") {
  throw new Error("request method result mismatch");
}

const container = { rpc: { request } };
const optionalRequest = container.rpc?.request?.getMachineConnectionStatus;
if (typeof optionalRequest !== "function") {
  throw new Error(`optional request method type mismatch: ${typeof optionalRequest}`);
}

if (optionalRequest("y") !== "getMachineConnectionStatus:y") {
  throw new Error("optional request method result mismatch");
}

console.log("proxy function passed");
