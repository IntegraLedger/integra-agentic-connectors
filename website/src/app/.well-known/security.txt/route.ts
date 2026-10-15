import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { absoluteUrl, repoFile, siteConfig } from "@/lib/site";

export const dynamic = "force-static";

/**
 * The committer date of the commit the site is built from, in milliseconds since the epoch. Outside a git checkout,
 * the build's clock.
 */
function commitTime(): number {
  let seconds: string;
  try {
    // `next build` runs in website/; the repository is its parent.
    seconds = execFileSync("git", ["log", "-1", "--format=%ct", "HEAD"], {
      cwd: resolve(process.cwd(), ".."),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return Date.now();
  }
  return Number(seconds.trim()) * 1000;
}

/**
 * `/.well-known/security.txt` (RFC 9116): report a vulnerability through GitHub's private vulnerability
 * reporting, under the repository's security policy. `Expires` is 180 days after the committer date of the commit the
 * site is built from, inside the year RFC 9116 recommends: each new commit renews it, and two builds of one commit
 * write the same file. Outside a git checkout it is 180 days after the build.
 */
export function GET() {
  const expires = new Date(commitTime() + 180 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  const text = [
    `Contact: ${siteConfig.securityUrl}`,
    `Expires: ${expires.toISOString()}`,
    `Policy: ${repoFile("SECURITY.md")}`,
    "Preferred-Languages: en",
    `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
    "",
  ].join("\n");
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
