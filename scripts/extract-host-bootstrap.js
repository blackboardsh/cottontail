#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("usage: extract-host-bootstrap.js INPUT OUTPUT");
}

const input = readFileSync(inputPath, "utf8");
const hostApi = input.indexOf("static int ct_install_host_api");
const start = input.indexOf("static const char bootstrap_source[] =", hostApi);
const end = input.indexOf("\n    ;", start);
if (hostApi < 0 || start < 0 || end < 0) {
  throw new Error("could not locate the host bootstrap C string");
}

const literals = input.slice(start, end).match(/"(?:[^"\\]|\\.)*"/gs) ?? [];
const source = literals.map(literal => JSON.parse(literal)).join("");
if (!source.startsWith("globalThis.global = globalThis;") || source.length < 1_000) {
  throw new Error("extracted host bootstrap failed its integrity check");
}

writeFileSync(outputPath, source);
