import { createRequire } from "node:module";
import { withChrome } from "../lib/chrome";

/** A diagram as SVG in each of the site's two themes. */
export interface DiagramSvg {
  light: string;
  dark: string;
}

/** The font the diagrams are measured and drawn in: the site's sans-serif stack. */
const FONT = "ui-sans-serif, system-ui, sans-serif";

/**
 * Renders Mermaid diagrams to SVG with the `mermaid` package itself, in a headless Google Chrome (or the
 * Chrome or Chromium executable that `CHROME_PATH` names; `withChrome`), once in Mermaid's `default` theme and once
 * in its `dark` theme. `prefix` and each chart's index make the SVG ids unique on the page. An id inside an SVG that
 * nothing in that SVG references is removed, so the two copies of a diagram share no id.
 */
export async function renderMermaid(charts: string[], prefix: string): Promise<DiagramSvg[]> {
  const script = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
  return withChrome("Mermaid diagrams are rendered at build time", async (context) => {
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: script });
    return await page.evaluate(
      async ({ charts, prefix, font }) => {
        interface Mermaid {
          initialize(config: Record<string, unknown>): void;
          render(id: string, text: string): Promise<{ svg: string }>;
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
              fontFamily: font,
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
  });
}
