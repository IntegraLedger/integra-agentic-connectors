import { markdownPath, pageDocument } from "@/lib/llms";
import { source } from "@/lib/source";

export const dynamic = "force-static";
export const dynamicParams = false;

/** `/md/<path>.md`: one documentation page as Markdown. */
export function generateStaticParams() {
  return source.getPages().map((page) => ({
    slug: markdownPath(page.url).split("/").filter(Boolean).slice(1),
  }));
}

export async function GET(_request: Request, context: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await context.params;
  const path = `/md/${slug.join("/")}`;
  const page = source.getPages().find((p) => markdownPath(p.url) === path);
  if (!page) return new Response("not found", { status: 404 });
  return new Response(await pageDocument(page), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
