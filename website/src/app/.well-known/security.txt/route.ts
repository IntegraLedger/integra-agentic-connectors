import { absoluteUrl, repoFile, siteConfig } from "@/lib/site";

export const dynamic = "force-static";

/**
 * `/.well-known/security.txt` (RFC 9116): report a vulnerability through GitHub's private vulnerability
 * reporting, under the repository's security policy. `Expires` is 180 days after the build, inside the year
 * RFC 9116 recommends, so each deploy of a new build renews it.
 */
export function GET() {
  const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
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
