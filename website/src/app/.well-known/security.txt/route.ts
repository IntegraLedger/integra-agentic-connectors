import { absoluteUrl, siteConfig } from "@/lib/site";

export const dynamic = "force-static";

/** `/.well-known/security.txt` (RFC 9116). `Expires` is one year after the build. */
export function GET() {
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  const text = [
    `Contact: ${siteConfig.securityUrl}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Canonical: ${absoluteUrl("/.well-known/security.txt")}`,
    "",
  ].join("\n");
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
