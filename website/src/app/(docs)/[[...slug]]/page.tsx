import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { Mermaid } from "@/components/Mermaid";
import { TwoslashPopups } from "@/components/TwoslashPopups";
import { markdownPath, markdownUrl } from "@/lib/llms";
import { absoluteUrl, breadcrumbJsonLd, docSourcePath, ogImagePath, repoFile, siteConfig } from "@/lib/site";
import { isGenerated, source } from "@/lib/source";
import { popupsPath, twoslashPopups } from "@/lib/twoslash";

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

/** Home, then each ancestor that is a page, then the page itself. */
function crumbs(slug: string[], title: string) {
  const out = [{ name: "Home", path: "/" }];
  slug.forEach((_, i) => {
    const sub = slug.slice(0, i + 1);
    const page = i === slug.length - 1 ? undefined : source.getPage(sub);
    if (i === slug.length - 1) out.push({ name: title, path: `/${sub.join("/")}` });
    else if (page) out.push({ name: page.data.title, path: page.url });
  });
  return out;
}

export default async function Page(props: PageProps) {
  const { slug = [] } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const MDX = page.data.body;
  const lastModified = page.data.lastModified;
  const sourcePath = docSourcePath(page.data.info.path);
  const generated = isGenerated(page.data.info.path);
  const copyPath = markdownPath(page.url);

  const article = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: page.data.title,
    description: page.data.description,
    url: absoluteUrl(page.url),
    inLanguage: "en",
    isPartOf: { "@id": `${siteConfig.url}/#website` },
    publisher: { "@id": `${siteConfig.url}/#organization` },
    license: siteConfig.license.url,
    ...(lastModified ? { dateModified: lastModified.toISOString() } : {}),
  };

  return (
    <DocsPage
      id="main"
      tabIndex={-1}
      toc={page.data.toc}
      full={page.data.full}
      {...(lastModified ? { lastUpdate: lastModified } : {})}
      {...(generated
        ? {}
        : {
            editOnGithub: {
              owner: siteConfig.github.owner,
              repo: siteConfig.github.repo,
              sha: "main",
              path: sourcePath,
            },
          })}
    >
      <JsonLd
        data={[
          article,
          ...(slug.length > 0 ? [breadcrumbJsonLd(crumbs(slug, page.data.title))] : []),
        ]}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="flex flex-row items-center gap-2 border-b pb-6">
        <MarkdownCopyButton markdownUrl={copyPath} />
        <ViewOptionsPopover
          markdownUrl={absoluteUrl(copyPath)}
          githubUrl={repoFile(sourcePath)}
          pageUrl={absoluteUrl(page.url)}
        />
      </div>
      <DocsBody>
        <MDX components={{ ...defaultMdxComponents, Mermaid }} />
      </DocsBody>
      {twoslashPopups(page).length > 0 ? <TwoslashPopups src={popupsPath(page.url)} /> : null}
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug = [] } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const home = page.url === "/";
  const description = page.data.description ?? siteConfig.description;
  const title = home ? siteConfig.title : page.data.title;
  const image = { url: ogImagePath(page.slugs), width: 1200, height: 630, alt: title };
  return {
    title: home ? { absolute: siteConfig.title } : page.data.title,
    description,
    alternates: {
      canonical: page.url,
      types: { "text/markdown": markdownUrl(page.url) },
    },
    openGraph: {
      type: home ? "website" : "article",
      url: absoluteUrl(page.url),
      title,
      description,
      siteName: siteConfig.name,
      locale: siteConfig.locale,
      images: [image],
      ...(page.data.lastModified && !home
        ? { modifiedTime: page.data.lastModified.toISOString() }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
