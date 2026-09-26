#!/usr/bin/env node
// Writes src/embedded.ts: the text of openapi.json and of each vectors/CV<n>.json, in number order, so the built package
// carries them as code and reads no file when it loads. Each file must be UTF-8 whose text encodes back to the same
// bytes.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function text(path) {
  const bytes = readFileSync(new URL(path, root));
  const s = decoder.decode(bytes);
  if (!Buffer.from(encoder.encode(s)).equals(bytes)) throw new Error(`${path}: its text does not encode back to its bytes`);
  return s;
}

const vectors = readdirSync(new URL("vectors/", root))
  .filter((f) => /^CV[0-9]+\.json$/.test(f))
  .sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)));

const lines = [
  "// Written by scripts/embed.mjs from openapi.json and vectors/CV<n>.json: each file's text.",
  `export const OPENAPI_TEXT: string = ${JSON.stringify(text("openapi.json"))};`,
  "export const VECTOR_TEXTS: readonly (readonly [string, string])[] = [",
  ...vectors.map((f) => `  [${JSON.stringify(f.slice(0, -5))}, ${JSON.stringify(text(`vectors/${f}`))}],`),
  "];",
  "",
];
writeFileSync(new URL("src/embedded.ts", root), lines.join("\n"));
