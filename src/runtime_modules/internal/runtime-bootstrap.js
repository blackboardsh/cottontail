import bunObject, {
  Bun,
  installRuntimeBootstrap,
  process as processObject,
} from "./runtime-bootstrap-core.js";
import "./runtime-stack-remap.js";
import { installStandaloneRuntimeLoaders } from "./standalone-runtime.js";

installStandaloneRuntimeLoaders(processObject);

export { Bun, installRuntimeBootstrap, processObject as process };
export default bunObject;
