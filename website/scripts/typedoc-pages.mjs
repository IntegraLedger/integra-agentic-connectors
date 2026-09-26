// A TypeDoc plugin for the API pages: each page gets YAML frontmatter (`title`, `description`) and a first heading
// naming the package it documents, and the output folder gets a `meta.json` listing its one page.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RendererEvent } from "typedoc";
import { MarkdownPageEvent } from "typedoc-plugin-markdown";

const folder = process.env.API_PACKAGE;
const manifest = JSON.parse(readFileSync(new URL(`../../${folder}/package.json`, import.meta.url), "utf8"));
const packageName = manifest.name;

/** @param {import("typedoc").Application} app */
export function load(app) {
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    if (page.contents === undefined) return;
    const summary = page.model.comment?.summary?.map((part) => part.text).join("").trim() ?? "";
    const first = summary.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
    const description = first.length > 0 ? first : `The exports of ${packageName}.`;
    const body = page.contents.replace(/^# .*\n/, "");
    page.contents = [
      "---",
      `title: ${JSON.stringify(packageName)}`,
      `description: ${JSON.stringify(description)}`,
      "---",
      "",
      `# ${packageName}`,
      "",
      body.replace(/^\n+/, ""),
    ].join("\n");
  });

  app.renderer.on(RendererEvent.END, (event) => {
    const meta = { title: packageName, pages: ["index"] };
    writeFileSync(join(event.outputDirectory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  });
}
