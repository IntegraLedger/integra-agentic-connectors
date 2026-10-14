// The site's Worker. The exported site in out/ is its static assets; wrangler.toml runs this script first for page
// addresses and their .md addresses, and never for the build's files (scripts, the pages' RSC payloads, the Markdown
// copies), so that a reader who asks for a page as Markdown gets the page's Markdown copy, which the build writes at
// /md/<page>.md:
//
//   GET /<page>.md, /index.md                 the page as Markdown (https://llmstxt.org)
//   GET /<page> with an Accept that ranks     the same Markdown, at the page's own address
//     text/markdown or text/x-markdown at
//     least as high as text/html, text/* and */*
//
// Every other request is answered by the static assets, which redirect a page address that ends in a slash to the
// address without it, whatever the Accept header asks for. Each response here is an asset response, so the rules in
// _headers apply to it; a request carrying If-None-Match or another conditional header can be answered 304; and a
// page address's response carries `Vary: Accept`.
import { isMarkdownPreferred } from "fumadocs-core/negotiation";

/** The media types that ask for Markdown. `text/plain` is not one of them: it asks for any text. */
const MARKDOWN_TYPES = ["text/markdown", "text/x-markdown"];

/** The path of a page's Markdown copy: `/md/<page>.md`, and `/md/index.md` for the home page. */
function copyOf(page) {
  return page === "/" ? "/md/index.md" : `/md${page}.md`;
}

/** The page a .md address names: the home page for `/index.md`, `<page>` for `/<page>.md`, else none. */
function pageOf(pathname) {
  if (pathname === "/index.md") return "/";
  const page = pathname.slice(0, -".md".length);
  return page.endsWith("/") ? undefined : page;
}

/**
 * The page's Markdown copy as a 200 or 304 response, or undefined when the site holds no copy for that page. The
 * request's conditional headers go with it, so a copy the reader holds is answered 304.
 */
async function markdown(env, request, page) {
  const headers = new Headers();
  for (const [name, value] of request.headers) if (name.startsWith("if-")) headers.set(name, value);
  const response = await env.ASSETS.fetch(
    new Request(new URL(copyOf(page), request.url), { method: request.method, headers }),
  );
  return response.status === 200 || response.status === 304 ? response : undefined;
}

function varyOnAccept(response) {
  const out = new Response(response.body, response);
  out.headers.append("Vary", "Accept");
  return out;
}

export default {
  async fetch(request, env) {
    if (request.method === "GET" || request.method === "HEAD") {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith(".md")) {
        const page = pageOf(pathname);
        const found = page === undefined ? undefined : await markdown(env, request, page);
        if (found !== undefined) return found;
      } else if (
        (pathname === "/" || !pathname.endsWith("/")) &&
        isMarkdownPreferred(request, { markdownMediaTypes: MARKDOWN_TYPES })
      ) {
        const found = await markdown(env, request, pathname);
        if (found !== undefined) return varyOnAccept(found);
      }
    }
    return varyOnAccept(await env.ASSETS.fetch(request));
  },
};
