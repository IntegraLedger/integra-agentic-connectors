import { orderedPages } from "@/lib/llms";
import { absoluteUrl, siteConfig } from "@/lib/site";

export const dynamic = "force-static";

/** `/llms.txt`: the site's index for language models (https://llmstxt.org), in sidebar order. */
export function GET() {
  const lines: string[] = [
    `# ${siteConfig.name}`,
    "",
    `> ${siteConfig.description}`,
    "",
    `- Every page as one Markdown file: ${siteConfig.url}/llms-full.txt`,
    `- Each page as Markdown: ${siteConfig.url}/md/<path>.md`,
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
    lines.push(`- [${page.data.title}](${absoluteUrl(page.url)})${description}`);
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
