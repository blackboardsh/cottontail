import { loadEmbeddedRuntimeModule } from "../node/module.js";
const namespace = loadEmbeddedRuntimeModule("bun/socket.js");
export const { connect, listen } = namespace;
