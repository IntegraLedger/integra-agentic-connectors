import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { Mark } from "@/components/Mark";
import { siteConfig } from "@/lib/site";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="flex items-center gap-2 font-semibold">
            <Mark size={22} className="text-fd-primary" />
            {siteConfig.name}
          </span>
        ),
      }}
      githubUrl={siteConfig.githubUrl}
      links={siteConfig.packages.map((pkg) => ({ text: pkg.name, url: pkg.npm, external: true }))}
      sidebar={{ defaultOpenLevel: 1 }}
    >
      {children}
    </DocsLayout>
  );
}
