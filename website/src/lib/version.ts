import { readFileSync } from "node:fs";
import { join } from "node:path";
import { siteConfig } from "@/lib/site";

/**
 * The version of each package these pages document, by package name, read from its manifest at build time.
 * Server components only: it reads the filesystem.
 */
export const packageVersions: Readonly<Record<string, string>> = Object.fromEntries(
  siteConfig.packages.map((pkg) => {
    // `next build` runs in website/; each package's manifest is at ../<folder>/package.json.
    const manifest = join(process.cwd(), "..", pkg.folder, "package.json");
    const { version } = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`${manifest} carries no version`);
    }
    return [pkg.name, version];
  }),
);
