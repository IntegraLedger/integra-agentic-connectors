import { orderedPages, pageDocument } from "@/lib/llms";
import { siteConfig } from "@/lib/site";

export const dynamic = "force-static";

/** `/llms-full.txt`: every documentation page as Markdown, in sidebar order. */
export async function GET() {
  const sections = await Promise.all(orderedPages().map(({ page }) => pageDocument(page)));
  const header = [
    `# ${siteConfig.name}`,
    "",
    `> ${siteConfig.description}`,
    "",
    `Site: ${siteConfig.url} · Index: ${siteConfig.url}/llms.txt`,
    "",
  ].join("\n");
  return new Response(`${header}\n${sections.map((s) => s.trim()).join("\n\n---\n\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
