import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const withMDX = createMDX();
const repoRoot = resolve(import.meta.dirname, "..");

function git(args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });
}

/**
 * The build ID. Every page carries it, and it names the folder of the build's manifests under `/_next/static/`, which
 * `public/_headers` serves as immutable, so it changes whenever anything the site serves can change:
 * - from a commit with no uncommitted change, it is the commit's sha. The commit fixes the pages, the packages the
 *   samples are checked against, the locked dependencies and each page's last-updated date (its file's last commit),
 *   so one commit gives one ID, and one site byte for byte on one machine. The machine's Chrome and fonts draw the
 *   Mermaid diagrams (src/mdx/mermaid.ts), which are in the pages, never under `/_next/static/`;
 * - with uncommitted changes, it is the sha, a hyphen and 16 hex digits of a SHA-256 over the changes: the diff of
 *   the tracked files against the commit and each untracked file that is not ignored, by path and content;
 * - outside a git checkout, Next.js draws a random ID, and no page has a last-updated date.
 */
function buildId(): string | null {
  let head: string;
  try {
    head = git(["rev-parse", "--verify", "HEAD"]).toString().trim();
  } catch (error) {
    const reason = (error as { stderr?: Buffer }).stderr?.toString().trim().split("\n")[0] ?? String(error);
    console.warn(`the build ID is random: no commit to name it after (git rev-parse HEAD: ${reason})`);
    return null;
  }
  const tracked = git(["diff", "HEAD", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv"]);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"])
    .toString()
    .split("\0")
    .filter((path) => path !== "")
    .sort();
  if (tracked.length === 0 && untracked.length === 0) return head;
  const top = git(["rev-parse", "--show-toplevel"]).toString().trim();
  const digest = createHash("sha256").update(tracked);
  for (const path of untracked) {
    digest.update(`${path}\0`).update(createHash("sha256").update(readFileSync(resolve(top, path))).digest());
  }
  return `${head}-${digest.digest("hex").slice(0, 16)}`;
}

const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  generateBuildId: buildId,
  // The pages are read from outside this folder (../docs), so the bundler's root is the repository's folder.
  outputFileTracingRoot: resolve(import.meta.dirname, ".."),
  turbopack: { root: resolve(import.meta.dirname, "..") },
};

export default withMDX(config);
