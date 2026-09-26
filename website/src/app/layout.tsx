import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/JsonLd";
import { organizationJsonLd, siteConfig, softwareJsonLd, webSiteJsonLd } from "@/lib/site";
import { packageVersions } from "@/lib/version";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: { template: siteConfig.titleTemplate, default: siteConfig.title },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  keywords: [...siteConfig.keywords],
  authors: [{ name: siteConfig.publisher.name, url: siteConfig.publisher.url }],
  creator: siteConfig.publisher.name,
  publisher: siteConfig.publisher.name,
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    title: siteConfig.title,
    description: siteConfig.description,
    url: siteConfig.url,
    locale: siteConfig.locale,
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.title,
    description: siteConfig.description,
  },
  alternates: {
    types: { "text/plain": [{ url: "/llms.txt", title: "llms.txt" }] },
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-fd-primary px-4 py-2 text-fd-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <JsonLd
          data={[
            organizationJsonLd(),
            webSiteJsonLd(),
            ...siteConfig.packages.map((pkg) => softwareJsonLd(pkg, packageVersions[pkg.name] ?? "")),
          ]}
        />
        <RootProvider search={{ enabled: true, options: { type: "static", api: "/api/search" } }}>
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
