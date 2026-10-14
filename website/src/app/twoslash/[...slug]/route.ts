import { source } from "@/lib/source";
import { popupsPath, twoslashPopups } from "@/lib/twoslash";

export const dynamic = "force-static";
export const dynamicParams = false;

/** `/twoslash/<path>.json`: one page's Twoslash popups, for each page that has any. */
export function generateStaticParams() {
  return source
    .getPages()
    .filter((page) => twoslashPopups(page).length > 0)
    .map((page) => ({ slug: popupsPath(page.url).split("/").filter(Boolean).slice(1) }));
}

export async function GET(_request: Request, context: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await context.params;
  const path = `/twoslash/${slug.join("/")}`;
  const page = source.getPages().find((p) => popupsPath(p.url) === path);
  if (!page) return new Response("not found", { status: 404 });
  return Response.json(twoslashPopups(page));
}
