import {
  Network,
  NetworkResources,
  close,
  console,
  open,
  url,
  waitForDebugger,
  Session as CallbackSession,
} from "../inspector.js";

export { Network, NetworkResources, close, console, open, url, waitForDebugger };

export class Session extends CallbackSession {
  post(method, params = undefined) {
    return new Promise((resolve, reject) => {
      super.post(method, params, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  }
}

export default {
  Network,
  NetworkResources,
  Session,
  close,
  console,
  open,
  url,
  waitForDebugger,
};
