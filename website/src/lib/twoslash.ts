import type { source } from "@/lib/source";

type DocPage = ReturnType<typeof source.getPages>[number];

/** Where a page's Twoslash popups are served: `/twoslash/<path>.json`, and `/twoslash/index.json` for the home page. */
export function popupsPath(url: string): string {
  return url === "/" ? "/twoslash/index.json" : `/twoslash${url}.json`;
}

/** A page's Twoslash popups, as HTML, numbered as its trigger buttons name them; empty when it has none. */
export function twoslashPopups(page: DocPage): string[] {
  const popups: unknown = page.data._exports.twoslashPopups;
  return Array.isArray(popups) && popups.every((p) => typeof p === "string") ? popups : [];
}
