import * as asyncHooks from "./runtime_modules/node/async_hooks.js";
import * as buffer from "./runtime_modules/node/buffer.js";
import * as crypto from "./runtime_modules/node/crypto.js";
import * as events from "./runtime_modules/node/events.js";
import * as fs from "./runtime_modules/node/fs.js";
import * as http from "./runtime_modules/node/http.js";
import * as net from "./runtime_modules/node/net.js";
import * as path from "./runtime_modules/node/path.js";
import * as stream from "./runtime_modules/node/stream.js";
import * as tls from "./runtime_modules/node/tls.js";
import * as tty from "./runtime_modules/node/tty.js";
import * as url from "./runtime_modules/node/url.js";
import * as util from "./runtime_modules/node/util.js";
import * as v8 from "./runtime_modules/node/v8.js";

export {
  asyncHooks,
  buffer,
  crypto,
  events,
  fs,
  http,
  net,
  path,
  stream,
  tls,
  tty,
  url,
  util,
  v8,
};

globalThis.__cottontailCapabilityResult = {
  modules: {
    "node:async_hooks": asyncHooks,
    "node:buffer": buffer,
    "node:crypto": crypto,
    "node:events": events,
    "node:fs": fs,
    "node:http": http,
    "node:net": net,
    "node:path": path,
    "node:stream": stream,
    "node:tls": tls,
    "node:tty": tty,
    "node:url": url,
    "node:util": util,
    "node:v8": v8,
  },
};
