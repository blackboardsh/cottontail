import { probeHTTPCompression } from "./compression-http-probe.mjs";

self.onmessage = async event => {
  self.postMessage(await probeHTTPCompression(event.data));
};
