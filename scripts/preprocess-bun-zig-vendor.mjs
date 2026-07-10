#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "vendors/bun-zig/src";

function isIdentStart(ch) {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isIdentContinue(ch) {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function rewritePrivateIdentifiers(source) {
  let out = "";
  let i = 0;
  let lineOnlyWhitespace = true;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineOnlyWhitespace && (ch === " " || ch === "\t" || ch === "\r")) {
      out += ch;
      i++;
      continue;
    }

    if (lineOnlyWhitespace && ch === "\\" && next === "\\") {
      const end = source.indexOf("\n", i);
      if (end === -1) {
        out += source.slice(i);
        break;
      }
      out += source.slice(i, end + 1);
      i = end + 1;
      lineOnlyWhitespace = true;
      continue;
    }

    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      if (end === -1) {
        out += source.slice(i);
        break;
      }
      out += source.slice(i, end + 1);
      i = end + 1;
      lineOnlyWhitespace = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i++;
        if (c === "\\") {
          if (i < source.length) {
            out += source[i];
            i++;
          }
          continue;
        }
        if (c === '"') break;
      }
      lineOnlyWhitespace = false;
      continue;
    }

    if (ch === "'") {
      out += ch;
      i++;
      while (i < source.length) {
        const c = source[i];
        out += c;
        i++;
        if (c === "\\") {
          if (i < source.length) {
            out += source[i];
            i++;
          }
          continue;
        }
        if (c === "'") break;
      }
      lineOnlyWhitespace = false;
      continue;
    }

    if (ch === "#" && isIdentStart(next)) {
      out += "_";
      i++;
      while (i < source.length && isIdentContinue(source[i])) {
        out += source[i];
        i++;
      }
      lineOnlyWhitespace = false;
      continue;
    }

    out += ch;
    i++;
    if (ch === "\n") {
      lineOnlyWhitespace = true;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r") {
      lineOnlyWhitespace = false;
    }
  }

  return out;
}

function visit(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      visit(path);
      continue;
    }
    if (!entry.endsWith(".zig")) continue;
    const source = readFileSync(path, "utf8");
    const rewritten = rewritePrivateIdentifiers(source);
    if (rewritten !== source) writeFileSync(path, rewritten);
  }
}

visit(root);
