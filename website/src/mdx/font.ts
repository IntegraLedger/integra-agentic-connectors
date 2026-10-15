import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { brotliDecompressSync } from "node:zlib";

/** The family the Mermaid diagrams are measured and drawn in: Inter, from `@fontsource-variable/inter`. */
export const FONT = "Inter Variable";

/**
 * The package's stylesheet: one `@font-face` for each of Inter's subsets, each a WOFF2 file with a `unicode-range`,
 * for every weight. `src/app/global.css` imports it, so a reader's browser draws the diagrams in the same files.
 */
const STYLESHEET = "@fontsource-variable/inter/wght.css";

interface Face {
  file: string;
  bytes: Buffer;
  /** The `unicode-range` of the face, as inclusive [first, last] code point pairs. */
  ranges: [number, number][];
}

let loaded: { css: string; faces: Face[] } | undefined;

/** The stylesheet and its faces, read once from the installed package. */
function stylesheet(): { css: string; faces: Face[] } {
  if (loaded) return loaded;
  const path = createRequire(import.meta.url).resolve(STYLESHEET);
  const css = readFileSync(path, "utf8");
  const faces: Face[] = [];
  for (const [, block] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const file = /src:\s*url\(\.\/files\/([a-z0-9-]+\.woff2)\)/.exec(block ?? "")?.[1];
    const range = /unicode-range:\s*([^;]+);/.exec(block ?? "")?.[1];
    if (!file || !range || /[^U+0-9A-F,-]/.test(range.replace(/\s/g, ""))) {
      throw new Error(`${path}: a @font-face without one files/*.woff2 source and a unicode-range of code points`);
    }
    const ranges = range.split(",").map((r): [number, number] => {
      const [first, last = first] = r.trim().replace(/^U\+/, "").split("-");
      return [Number.parseInt(first ?? "", 16), Number.parseInt(last ?? "", 16)];
    });
    faces.push({ file, bytes: readFileSync(join(dirname(path), "files", file)), ranges });
  }
  if (faces.length === 0) throw new Error(`${path} holds no @font-face`);
  const inlined = css.replace(/url\(\.\/files\/([a-z0-9-]+\.woff2)\)/g, (_, file: string) => {
    const face = faces.find((f) => f.file === file);
    return `url(data:font/woff2;base64,${face?.bytes.toString("base64")})`;
  });
  loaded = { css: inlined, faces };
  return loaded;
}

/** The package's stylesheet with each font file inlined as a `data:` URL, for a page that loads nothing else. */
export function fontFaceCss(): string {
  return stylesheet().css;
}

/**
 * The characters of `text` that the font does not draw: those that no face both lists in its `unicode-range` and maps
 * to a glyph in its `cmap` table. Line breaks and tabs are not drawn and are not counted.
 */
export function notInFont(text: string): string[] {
  const { faces } = stylesheet();
  const maps = faces.map((face) => ({ ranges: face.ranges, has: cmapOf(face.file, face.bytes) }));
  const missing = new Set<string>();
  for (const char of text) {
    if (char === "\n" || char === "\r" || char === "\t") continue;
    const cp = char.codePointAt(0) ?? 0;
    if (!maps.some((m) => m.ranges.some(([a, b]) => cp >= a && cp <= b) && m.has(cp))) missing.add(char);
  }
  return [...missing];
}

/**
 * Whether a WOFF2 font maps a code point to a glyph other than `.notdef`, read from its `cmap` table: a format 12
 * subtable for Unicode's full repertoire, or else a format 4 subtable for its Basic Multilingual Plane (W3C WOFF 2.0
 * §5; OpenType's cmap table).
 */
function cmapOf(name: string, woff2: Buffer): (cp: number) => boolean {
  if (woff2.toString("latin1", 0, 4) !== "wOF2" || woff2.toString("latin1", 4, 8) === "ttcf") {
    throw new Error(`${name} is not a WOFF2 file of one font`);
  }
  const numTables = woff2.readUInt16BE(12);
  const compressedSize = woff2.readUInt32BE(20);
  let at = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = woff2[at++] ?? 0;
      value = value * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error(`${name}: a UIntBase128 longer than 5 bytes`);
  };
  // The tables follow one another in the decompressed stream, in the directory's order, with no padding. The known
  // tag with index 0 is `cmap`, which is never transformed.
  let offset = 0;
  let cmap: { offset: number; length: number } | undefined;
  for (let i = 0; i < numTables; i++) {
    const flags = woff2[at++] ?? 0;
    const tag = flags & 0x3f;
    const version = flags >> 6;
    if (tag === 63) at += 4;
    const length = base128();
    // glyf (10) and loca (11) are transformed with version 0; every other table with any version but 0.
    const transformed = tag === 10 || tag === 11 ? version === 0 : version !== 0;
    const stored = transformed ? base128() : length;
    if (tag === 0) cmap = { offset, length };
    offset += stored;
  }
  if (!cmap) throw new Error(`${name} has no cmap table`);
  const data = brotliDecompressSync(woff2.subarray(at, at + compressedSize));
  const table = data.subarray(cmap.offset, cmap.offset + cmap.length);
  const subtables: { platform: number; encoding: number; format: number; at: number }[] = [];
  for (let i = 0; i < table.readUInt16BE(2); i++) {
    const record = 4 + i * 8;
    const start = table.readUInt32BE(record + 4);
    subtables.push({
      platform: table.readUInt16BE(record),
      encoding: table.readUInt16BE(record + 2),
      format: table.readUInt16BE(start),
      at: start,
    });
  }
  const unicode = (s: { platform: number; encoding: number }) =>
    s.platform === 0 || (s.platform === 3 && (s.encoding === 1 || s.encoding === 10));
  const full = subtables.find((s) => unicode(s) && s.format === 12);
  if (full) {
    const groups: [number, number, number][] = [];
    for (let i = 0; i < table.readUInt32BE(full.at + 12); i++) {
      const g = full.at + 16 + i * 12;
      groups.push([table.readUInt32BE(g), table.readUInt32BE(g + 4), table.readUInt32BE(g + 8)]);
    }
    return (cp) => groups.some(([first, last, glyph]) => cp >= first && cp <= last && glyph + (cp - first) !== 0);
  }
  const bmp = subtables.find((s) => unicode(s) && s.format === 4);
  if (!bmp) throw new Error(`${name} has no Unicode cmap subtable of format 12 or 4`);
  const segments = table.readUInt16BE(bmp.at + 6) / 2;
  const ends = bmp.at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (cp) => {
    if (cp > 0xffff) return false;
    for (let s = 0; s < segments; s++) {
      if (cp > table.readUInt16BE(ends + s * 2)) continue;
      const first = table.readUInt16BE(starts + s * 2);
      if (cp < first) return false;
      const delta = table.readUInt16BE(deltas + s * 2);
      const rangeOffset = table.readUInt16BE(rangeOffsets + s * 2);
      if (rangeOffset === 0) return ((cp + delta) & 0xffff) !== 0;
      const glyph = table.readUInt16BE(rangeOffsets + s * 2 + rangeOffset + (cp - first) * 2);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  };
}
