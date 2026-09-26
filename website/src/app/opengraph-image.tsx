import { ImageResponse } from "next/og";
import { siteConfig } from "@/lib/site";

export const dynamic = "force-static";
export const alt = siteConfig.ogImageAlt;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The Open Graph card: the mark, the site name and the one-line description. */
export default function OpenGraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "80px",
        background: "#0a0a0a",
        color: "#fafafa",
      }}
    >
      <svg width="96" height="96" viewBox="0 0 32 32" fill="none">
        <rect x="3" y="3" width="16" height="16" rx="3" stroke="#fafafa" strokeWidth="3" />
        <rect x="13" y="13" width="16" height="16" rx="3" fill="#fafafa" />
      </svg>
      <div style={{ marginTop: 48, fontSize: 72, fontWeight: 700 }}>{siteConfig.name}</div>
      <div style={{ marginTop: 24, fontSize: 32, lineHeight: 1.35, color: "#a3a3a3" }}>
        {siteConfig.description}
      </div>
    </div>,
    size,
  );
}
