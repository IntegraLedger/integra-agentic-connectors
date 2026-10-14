import type { StructuredDataContent } from "fumadocs-core/mdx-plugins/remark-structure";
import { createFromSource } from "fumadocs-core/search/server";
import { isGenerated, source } from "@/lib/source";

export const revalidate = false;

/**
 * A page's search contents with each table row split into one content per cell. fumadocs records a table row
 * as a Markdown table of the header and that row; a cell on its own is ranked by its own text, so a query for a
 * code in a table finds the cell that holds it.
 */
function byCell(contents: StructuredDataContent[]): StructuredDataContent[] {
  return contents.flatMap((content) => {
    if (content.table === undefined) return [content];
    const row = content.content.split("\n").at(-1) ?? "";
    return row
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replaceAll("\\|", "|"))
      .filter((cell) => cell !== "")
      .map((cell) => ({ heading: content.heading, content: cell }));
  });
}

/**
 * The search index, written once at build time and searched in the browser. A hand-written page is indexed
 * whole, one content per table cell; a generated API page by its title, description and headings, which name
 * every export it documents.
 */
export const { staticGET: GET } = createFromSource(source, {
  buildIndex(page) {
    const { headings, contents } = page.data.structuredData;
    return {
      id: page.url,
      url: page.url,
      title: page.data.title,
      description: page.data.description,
      structuredData: { headings, contents: isGenerated(page.data.info.path) ? [] : byCell(contents) },
    };
  },
});
