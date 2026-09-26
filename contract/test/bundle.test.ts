// The built package where there is no filesystem: dist/index.js bundled by esbuild for the neutral platform, then run in
// a bare node:vm context whose globals are the language's own plus TextEncoder and URL, with no require, no process and
// no Buffer, and where import.meta.url is not a file URL. The expected values are the package's own files: the bytes of
// openapi.json, and each vectors/CV<n>.json parsed, in number order.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const ENTRY = fileURLToPath(new URL("dist/index.js", root));

/** The bundle's exports, evaluated in a context holding only what an edge runtime's global scope offers. */
async function loadBundle(): Promise<{ exports: Record<string, unknown>; globals: string }> {
  expect(existsSync(ENTRY), "dist/index.js is missing: build the package first").toBe(true);
  const out = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    platform: "neutral",
    format: "iife",
    globalName: "contract",
    external: ["node:*"],
    define: { "import.meta.url": JSON.stringify("worker") },
    logLevel: "silent",
  });
  const context: Record<string, unknown> = { TextEncoder, URL };
  const globals = runInNewContext("[typeof require, typeof process, typeof Buffer].join()", context) as string;
  runInNewContext(out.outputFiles[0]!.text, context, { filename: "bundle.js" });
  return { exports: context["contract"] as Record<string, unknown>, globals };
}

const vectorFiles = readdirSync(new URL("vectors/", root))
  .filter((f) => /^CV[0-9]+\.json$/.test(f))
  .sort((a, b) => Number(a.slice(2, -5)) - Number(b.slice(2, -5)));

describe("the package bundled for an edge runtime", () => {
  it("loads with no filesystem, and carries openapi.json's bytes and the vectors", async () => {
    const { exports, globals } = await loadBundle();
    expect(globals).toBe("undefined,undefined,undefined");

    const bytes = exports["OPENAPI_BYTES"] as Uint8Array;
    const file = readFileSync(new URL("openapi.json", root));
    expect(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(file)).toBe(true);

    const vectors = exports["VECTORS"] as Record<string, unknown>;
    expect(Object.keys(vectors)).toEqual(vectorFiles.map((f) => f.slice(0, -5)));
    for (const f of vectorFiles) {
      const expected: unknown = JSON.parse(readFileSync(new URL(`vectors/${f}`, root), "utf8"));
      expect(JSON.stringify(vectors[f.slice(0, -5)])).toBe(JSON.stringify(expected));
      expect(vectors[f.slice(0, -5)]).toEqual(expected);
    }
  });
});
