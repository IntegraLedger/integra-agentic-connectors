// Each public entry point in package.json's `exports`, built, bundled by esbuild into one ES module behind an entry that
// imports it lazily with `import()`, as a Worker's bundler bundles it. Each bundle is written to a temporary folder and
// imported, and its lazy import is awaited under a bounded deadline, so an import that never settles fails the test
// instead of stalling it. The expected exports of each entry point are the names Node's own loader gives for the built
// file.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEADLINE_MS = 60_000;

const EXPORTS: Record<string, { default: string }> = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).exports;
const ENTRIES: [string, string][] = Object.entries(EXPORTS).map(([key, target]) => [key, join(ROOT, target.default)]);

const dir = mkdtempSync(join(tmpdir(), "lazy-bundle-"));
const bundles = new Map<string, string>();

/** Bundles an entry that imports `entry` lazily into one ES module file and returns its path. */
async function lazyBundle(n: number, entry: string): Promise<string> {
  const out = await build({
    stdin: { contents: `export const load = () => import(${JSON.stringify(entry)});`, resolveDir: ROOT, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const file = join(dir, `${n}.mjs`);
  writeFileSync(file, out.outputFiles[0]!.text);
  return file;
}

/** `p`, or the string "did not settle" when `p` has not settled within the deadline. */
async function within<T>(p: Promise<T>): Promise<T | "did not settle"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"did not settle">((resolve) => {
    timer = setTimeout(() => resolve("did not settle"), DEADLINE_MS);
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

beforeAll(async () => {
  for (const [, entry] of ENTRIES) {
    expect(existsSync(entry), `${entry} is missing: build the package first`).toBe(true);
  }
  const files = await Promise.all(ENTRIES.map(([, entry], i) => lazyBundle(i, entry)));
  ENTRIES.forEach(([key], i) => bundles.set(key, files[i]!));
}, DEADLINE_MS * 3);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("each public entry point in one bundle behind a lazy import()", () => {
  it.each(ENTRIES)("%s loads", async (key, entry) => {
    const { load } = (await import(pathToFileURL(bundles.get(key)!).href)) as {
      load: () => Promise<Record<string, unknown>>;
    };
    const m = await within(load());
    expect(m).not.toBe("did not settle");
    const expected = Object.keys(await import(pathToFileURL(entry).href)).sort();
    expect(Object.keys(m).sort()).toEqual(expected);
  }, DEADLINE_MS * 2);
});
