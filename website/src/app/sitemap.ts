import type { MetadataRoute } from "next";
import { orderedPages } from "@/lib/llms";
import { absoluteUrl } from "@/lib/site";

export const dynamic = "force-static";

/** Every documentation page, in sidebar order, dated by its last commit where git knows it. */
export default function sitemap(): MetadataRoute.Sitemap {
  return orderedPages().map(({ page }) => ({
    url: page.url === "/" ? absoluteUrl("/").replace(/\/$/, "") : absoluteUrl(page.url),
    ...(page.data.lastModified ? { lastModified: page.data.lastModified } : {}),
    changeFrequency: "weekly" as const,
    priority: page.url === "/" ? 1 : 0.7,
  }));
}
