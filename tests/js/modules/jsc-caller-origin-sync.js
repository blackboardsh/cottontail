import { callerSourceOrigin } from "bun:jsc";

export const metaUrl = import.meta.url;
export const sourceOrigin = callerSourceOrigin();
