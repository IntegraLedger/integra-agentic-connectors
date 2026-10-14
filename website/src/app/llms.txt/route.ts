import { markdownUrl, orderedPages } from "@/lib/llms";
import { absoluteUrl, siteConfig } from "@/lib/site";

export const dynamic = "force-static";

/**
 * `/llms.txt`: the site's index for language models (https://llmstxt.org), in sidebar order, linking
 * each page as Markdown.
 */
export function GET() {
  const lines: string[] = [
    `# ${siteConfig.name}`,
    "",
    `> ${siteConfig.description}`,
    "",
    "Each page link below is the page as Markdown; the same page as HTML is the link without `.md`. A",
    "request whose Accept header prefers `text/markdown` gets the Markdown at the HTML address too.",
    "",
    `- Every page as one Markdown file: ${siteConfig.url}/llms-full.txt`,
    `- Source: ${siteConfig.githubUrl}`,
    ...siteConfig.packages.map((pkg) => `- npm: ${pkg.npm}`),
    `- License: ${siteConfig.license.name}`,
  ];

  let section: string | undefined;
  let first = true;
  for (const { section: s, page } of orderedPages()) {
    if (first || s !== section) {
      section = s;
      first = false;
      lines.push("", `## ${section ?? "Documentation"}`, "");
    }
    const description = page.data.description ? `: ${page.data.description}` : "";
    lines.push(`- [${page.data.title}](${absoluteUrl(markdownUrl(page.url))})${description}`);
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
