import type { Folder, Node, Root } from "fumadocs-core/page-tree";
import { siteConfig } from "@/lib/site";
import { source } from "@/lib/source";

type DocPage = ReturnType<typeof source.getPages>[number];

export interface OrderedPage {
  /** The sidebar section the page sits under, from its nearest separator. */
  section: string | undefined;
  page: DocPage;
}

function label(name: unknown): string | undefined {
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * Every documentation page in sidebar order, with the section it sits under. Pages that no
 * `meta.json` lists follow at the end.
 */
export function orderedPages(): OrderedPage[] {
  const byUrl = new Map(source.getPages().map((page) => [page.url, page]));
  const out: OrderedPage[] = [];
  const seen = new Set<string>();

  const push = (url: string, section: string | undefined) => {
    const page = byUrl.get(url);
    if (!page || seen.has(url)) return;
    seen.add(url);
    out.push({ section, page });
  };

  const walk = (nodes: Node[], section: string | undefined) => {
    let current = section;
    for (const node of nodes) {
      if (node.type === "separator") {
        current = label(node.name) ?? current;
      } else if (node.type === "folder") {
        const folder: Folder = node;
        if (folder.index) push(folder.index.url, current);
        walk(folder.children, current);
      } else if (!node.external) {
        push(node.url, current);
      }
    }
  };

  const root: Root = source.pageTree;
  walk(root.children, undefined);
  for (const page of source.getPages()) push(page.url, undefined);
  return out;
}

/** Where the build writes a page's Markdown copy: `/md/<path>.md`, and `/md/index.md` for the home page. */
export function markdownPath(url: string): string {
  return url === "/" ? "/md/index.md" : `/md${url}.md`;
}

/**
 * Where a reader asks for a page as Markdown: the page's address with `.md` appended
 * (https://llmstxt.org), and `/index.md` for the home page. The site's Worker (`worker.js`) answers
 * it with the page's Markdown copy.
 */
export function markdownUrl(url: string): string {
  return url === "/" ? "/index.md" : `${url}.md`;
}

/**
 * A page's body as portable Markdown: its authored Markdown with the edits the remark plugins make
 * through `replaceSource()` (the leading title and raw anchors removed, links rewritten to site and
 * repository URLs), numeric character references decoded and root-relative links made absolute.
 */
export async function pageMarkdown(page: DocPage): Promise<string> {
  const processed = await page.data.getText("processed");
  const text = processed
    .replace(/&#x([0-9A-Fa-f]+);/g, (_: string, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/\]\(\/(?=[^)]*\))/g, `](${siteConfig.url}/`)
    .replace(/^(\[[^\]]+\]:\s*)\/(?=\S)/gm, `$1${siteConfig.url}/`);
  return `${text.trim()}\n`;
}

/** A page as a standalone Markdown document: title, description, canonical URL, body. */
export async function pageDocument(page: DocPage): Promise<string> {
  const body = await pageMarkdown(page);
  return [
    `# ${page.data.title}`,
    "",
    ...(page.data.description ? [`> ${page.data.description}`, ""] : []),
    `Source: ${new URL(page.url, siteConfig.url).toString()}`,
    "",
    body,
  ].join("\n");
}
