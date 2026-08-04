import { remapStackString, sourceContextForLocation } from "../vendor/sourcemap.js";

globalThis.__cottontailRemapStackString ??= remapStackString;
globalThis.__cottontailSourceContextForLocation ??= sourceContextForLocation;
