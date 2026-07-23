import { callerSourceOrigin } from "bun:jsc";

await Promise.resolve();

export const metaUrl = import.meta.url;
export const sourceOrigin = callerSourceOrigin();
