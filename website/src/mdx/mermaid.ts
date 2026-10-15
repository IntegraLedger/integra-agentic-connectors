import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { withChrome } from "../lib/chrome";
import { FONT, fontFaceCss, notInFont } from "./font";

/** A diagram as SVG in each of the site's two themes. */
export interface DiagramSvg {
  light: string;
  dark: string;
}

/** The browser's font configuration: no font folder and no rule. */
const FONTCONFIG = '<?xml version="1.0"?>\n<fontconfig></fontconfig>\n';

/**
 * Renders Mermaid diagrams to SVG with the `mermaid` package itself, in the headless browser build the repository
 * pins and fetches by its SHA-256 (`scripts/browser.mjs`; `withChrome`), once in Mermaid's `default` theme and once in
 * its `dark` theme. `prefix` and each chart's index make the SVG ids unique on the page. An id inside an SVG that
 * nothing in that SVG references is removed, so the two copies of a diagram share no id.
 *
 * Mermaid measures and draws every text in one font, Inter, from the package the lockfile pins (`./font.ts`), so one
 * commit gives one set of SVGs on any machine:
 * - the render page loads every face of the package's stylesheet, inlined, before the first diagram, and gives every
 *   element that font with `!important`, which also governs the generic `sans-serif` that Mermaid measures text in
 *   beside its configured font;
 * - the browser runs with an environment of its own, holding only its folder (`HOME`, `TMPDIR`), a font configuration
 *   in that folder with no font folder and no rule, and `TZ`, so neither the machine's fonts nor its rendering
 *   settings (hinting, antialiasing) reach a diagram;
 * - a chart with a character Inter does not draw is refused before the browser starts, since the browser has no other
 *   font to draw it in;
 * - the page reads its clock in UTC and formats in the en-US locale, so a chart that writes a date or a number writes it
 *   the same on every machine.
 * The SVGs name the font, and `src/app/global.css` loads the same files, so a reader sees the diagram in the font it
 * is measured in.
 */
export async function renderMermaid(charts: string[], prefix: string): Promise<DiagramSvg[]> {
  for (const [i, chart] of charts.entries()) {
    const missing = notInFont(chart);
    if (missing.length > 0) {
      const named = missing.map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")} "${c}"`);
      throw new Error(`Mermaid diagram ${i + 1} of the page has characters ${FONT} does not draw: ${named.join(", ")}`);
    }
  }
  const script = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
  const setup = async (dir: string) => {
    await writeFile(join(dir, "fonts.conf"), FONTCONFIG);
    return { env: { FONTCONFIG_FILE: join(dir, "fonts.conf"), TZ: "UTC" }, timezoneId: "UTC", locale: "en-US" };
  };
  return withChrome(async (context) => {
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addStyleTag({ content: `${fontFaceCss()}\n* { font-family: "${FONT}" !important; }` });
    await page.addScriptTag({ path: script });
    return await page.evaluate(
      async ({ charts, prefix, font }) => {
        interface Mermaid {
          initialize(config: Record<string, unknown>): void;
          render(id: string, text: string): Promise<{ svg: string }>;
        }
        for (const face of document.fonts) {
          await face.load();
        }
        const mermaid = (window as unknown as { mermaid: Mermaid }).mermaid;
        const withoutUnusedIds = (svg: string): string => {
          const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
          for (const el of doc.documentElement.querySelectorAll("[id]")) {
            if (!svg.includes(`#${el.id})`) && !svg.includes(`"#${el.id}"`)) el.removeAttribute("id");
          }
          return new XMLSerializer().serializeToString(doc.documentElement);
        };
        const out: { light: string; dark: string }[] = [];
        for (const [i, chart] of charts.entries()) {
          const svgs: Record<string, string> = {};
          for (const [name, theme] of [
            ["light", "default"],
            ["dark", "dark"],
          ] as const) {
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: "strict",
              theme,
              fontFamily: `"${font}"`,
              htmlLabels: false,
            });
            const { svg } = await mermaid.render(`${prefix}-${i}-${name}`, chart);
            svgs[name] = withoutUnusedIds(svg);
          }
          out.push({ light: svgs.light ?? "", dark: svgs.dark ?? "" });
        }
        return out;
      },
      { charts, prefix, font: FONT },
    );
  }, setup);
}
