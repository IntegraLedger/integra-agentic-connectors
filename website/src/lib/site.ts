/**
 * Site identity, canonical origin and the structured-data helpers built from them. Every
 * absolute URL the site emits is derived from `siteConfig.url`.
 *
 * Imported by client components too, so nothing here touches Node APIs.
 */

import { DOCS_DIR } from "@/lib/docs-dir";

export const siteConfig = {
  url: "https://connectors.integraledger.com",
  name: "Integra Agentic Connectors",
  title: "Integra Agentic Connectors: the seller door contract and the LCP profile facilitator",
  titleTemplate: "%s | Integra Agentic Connectors",
  description:
    "The seller door's contract, which connectors speak to issue an Agentic Transaction Record (ATR), claim a payment carrying its hash and report the settlement, and an x402 facilitator for the LCP profiles on Tron and Polkadot.",
  keywords: [
    "Legal Context Protocol",
    "LCP",
    "Agentic Transaction Record",
    "ATR",
    "ATR hash",
    "seller door",
    "connector",
    "x402",
    "x402 facilitator",
    "Tron",
    "Polkadot",
  ],
  github: {
    owner: "IntegraLedger",
    repo: "integra-agentic-connectors",
  },
  githubUrl: "https://github.com/IntegraLedger/integra-agentic-connectors",
  securityUrl: "https://github.com/IntegraLedger/integra-agentic-connectors/security/advisories/new",
  packages: [
    {
      name: "@integraledger/agentic-connectors",
      folder: "contract",
      npm: "https://www.npmjs.com/package/@integraledger/agentic-connectors",
    },
    {
      name: "@integraledger/profile-facilitator",
      folder: "profile-facilitator",
      npm: "https://www.npmjs.com/package/@integraledger/profile-facilitator",
    },
  ],
  license: {
    name: "Apache-2.0",
    url: "https://www.apache.org/licenses/LICENSE-2.0",
  },
  ogImage: "/opengraph-image",
  ogImageAlt: "Integra Agentic Connectors: the seller door contract and the LCP profile facilitator",
  locale: "en_US",
  publisher: {
    name: "Integra Ledger",
    url: "https://www.integraledger.com",
  },
} as const;

/** An absolute URL on the canonical origin for a root-relative path. */
export function absoluteUrl(path: string): string {
  return new URL(path, siteConfig.url).toString();
}

/** A file in the repository, on `main`, as a GitHub URL. `path` is relative to the repository root. */
export function repoFile(path: string): string {
  return `${siteConfig.githubUrl}/blob/main/${path}`;
}

/** The repository path of a documentation page, given its path inside the docs tree. */
export function docSourcePath(contentPath: string): string {
  return `${DOCS_DIR.replace(/^\.\.\//, "")}/${contentPath}`;
}

/** Organization JSON-LD for the publisher. */
export function organizationJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteConfig.url}/#organization`,
    name: siteConfig.publisher.name,
    url: siteConfig.publisher.url,
    logo: absoluteUrl("/icon.svg"),
    sameAs: [siteConfig.githubUrl],
  };
}

/** WebSite JSON-LD for this site. */
export function webSiteJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${siteConfig.url}/#website`,
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.description,
    inLanguage: "en",
    publisher: { "@id": `${siteConfig.url}/#organization` },
    license: siteConfig.license.url,
  };
}

/** SoftwareSourceCode JSON-LD for one of the packages, at the given version. */
export function softwareJsonLd(pkg: (typeof siteConfig.packages)[number], version: string) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    "@id": `${siteConfig.url}/#${pkg.folder}`,
    name: pkg.name,
    version,
    url: pkg.npm,
    codeRepository: siteConfig.githubUrl,
    programmingLanguage: "TypeScript",
    license: siteConfig.license.url,
    isPartOf: { "@id": `${siteConfig.url}/#website` },
    publisher: { "@id": `${siteConfig.url}/#organization` },
  };
}

/** BreadcrumbList JSON-LD for a page, from its labelled path segments. */
export function breadcrumbJsonLd(crumbs: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absoluteUrl(c.path),
    })),
  };
}
