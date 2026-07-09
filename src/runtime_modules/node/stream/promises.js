import { finished as finishedCallback, pipeline as pipelineCallback } from "../stream.js";

export function finished(stream, options = undefined) {
  return finishedCallback(stream, options);
}

export function pipeline(...streams) {
  return pipelineCallback(...streams);
}

export default { finished, pipeline };
