import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

export const source = loader({
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});

/** Whether a page is one of the API pages generated from the packages' source rather than written by hand. */
export function isGenerated(contentPath: string): boolean {
  return contentPath.startsWith("reference/api/");
}
