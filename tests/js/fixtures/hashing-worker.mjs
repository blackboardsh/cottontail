import { probeHashing } from "./hashing-probe.mjs";

self.onmessage = event => {
  self.postMessage(probeHashing(event.data));
};
