import { probeConnections } from "./tls-ca-probe.mjs";

self.onmessage = async event => {
  self.postMessage(await probeConnections(event.data));
};
