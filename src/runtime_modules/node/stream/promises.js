import { promises } from "../stream.js";

export const finished = promises.finished;
export const pipeline = promises.pipeline;

export default { finished, pipeline };
