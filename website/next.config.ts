import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();

const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // The pages are read from outside this folder (../docs), so the bundler's root is the repository's folder.
  outputFileTracingRoot: resolve(import.meta.dirname, ".."),
  turbopack: { root: resolve(import.meta.dirname, "..") },
};

export default withMDX(config);
