import { ImageResponse } from "next/og";
import { ogImagePath, siteConfig } from "@/lib/site";
import { source } from "@/lib/source";

export const dynamic = "force-static";
export const dynamicParams = false;

/** `/og/<path>/image.png`: a page's social card, 1200×630, written at build time. The home page's is `/og/image.png`. */
export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: ogImagePath(page.slugs).split("/").slice(2) }));
}

export async function GET(_request: Request, context: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await context.params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) return new Response("not found", { status: 404 });
  const home = page.url === "/";
  const title = home ? siteConfig.name : page.data.title;
  const description = (home ? undefined : page.data.description) ?? siteConfig.description;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "80px",
        background: "#0a0a0a",
        color: "#fafafa",
      }}
    >
      {/* The site's mark (src/components/Mark.tsx), drawn inline: the card is rendered at build time with no network. */}
      <svg width="96" height="96" viewBox="0 0 32 32" fill="none">
        <rect x="3" y="3" width="16" height="16" rx="3" stroke="#fafafa" strokeWidth="3" />
        <rect x="13" y="13" width="16" height="16" rx="3" fill="#fafafa" />
      </svg>
      <div style={{ marginTop: 48, fontSize: 72, fontWeight: 700, lineHeight: 1.15 }}>{title}</div>
      <div style={{ marginTop: 24, fontSize: 32, lineHeight: 1.35, color: "#a3a3a3" }}>{description}</div>
      {home ? null : (
        <div style={{ marginTop: "auto", fontSize: 32, fontWeight: 600, color: "#d4d4d4" }}>{siteConfig.name}</div>
      )}
    </div>,
    { width: 1200, height: 630 },
  );
}
