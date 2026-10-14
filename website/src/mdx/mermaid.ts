import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

/** A diagram as SVG in each of the site's two themes. */
export interface DiagramSvg {
  light: string;
  dark: string;
}

/** The font the diagrams are measured and drawn in: the site's sans-serif stack. */
const FONT = "ui-sans-serif, system-ui, sans-serif";

/**
 * Renders Mermaid diagrams to SVG with the `mermaid` package itself, in a headless Google Chrome (or the
 * Chrome or Chromium executable that `CHROME_PATH` names), once in Mermaid's `default` theme and once in its
 * `dark` theme. `prefix` and each chart's index make the SVG ids unique on the page. An id inside an SVG that
 * nothing in that SVG references is removed, so the two copies of a diagram share no id.
 *
 * Each call gives Chrome a folder of its own in the system temporary directory, holding its profile, Playwright's
 * artifacts and every file Chrome writes to `TMPDIR`. The folder is removed once the browser has closed, whether the
 * diagrams rendered or not, and also when Chrome fails to launch.
 */
export async function renderMermaid(charts: string[], prefix: string): Promise<DiagramSvg[]> {
  const script = createRequire(import.meta.url).resolve("mermaid/dist/mermaid.min.js");
  const executablePath = process.env.CHROME_PATH;
  // A short path: Chrome makes its SingletonSocket, a Unix socket, under TMPDIR, and a socket path has a length limit.
  const dir = await mkdtemp(join(tmpdir(), "mermaid-"));
  try {
    const context = await chromium
      .launchPersistentContext(join(dir, "profile"), {
        ...(executablePath ? { executablePath } : { channel: "chrome" }),
        artifactsDir: dir,
        env: { ...process.env, TMPDIR: dir },
      })
      .catch((e: unknown) => {
        throw new Error(
          "Mermaid diagrams are rendered at build time in Google Chrome: install it, or set CHROME_PATH to a Chrome or Chromium executable",
          { cause: e },
        );
      });
    try {
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
    } finally {
      await context.close();
    }
  } finally {
    // When a launch fails, Chrome can still be closing and writing to its profile: Playwright closes it, or kills
    // it after 30 seconds. The removal retries for 36 seconds in all (1 + 2 + ... + 8), longer than that.
    await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 1000 });
  }
}
