// `pnpm run api`: a Markdown API page for each package's entry point, written into the documentation tree at
// reference/api/<name>/. API_PACKAGE names the package's folder: contract or profile-facilitator.
import { readFileSync } from "node:fs";
import { DOCS_DIR } from "./src/lib/docs-dir.ts";

const folder = process.env.API_PACKAGE;
if (folder !== "contract" && folder !== "profile-facilitator") {
  throw new Error("set API_PACKAGE to contract or profile-facilitator");
}
const manifest = JSON.parse(readFileSync(new URL(`../${folder}/package.json`, import.meta.url), "utf8"));
const name = manifest.name.replace(/^@integraledger\//, "");

/** @type {import("typedoc").TypeDocOptions & import("typedoc-plugin-markdown").PluginOptions} */
export default {
  entryPoints: [`../${folder}/src/index.ts`],
  tsconfig: `../${folder}/tsconfig.json`,
  out: `${DOCS_DIR}/reference/api/${name}`,
  plugin: ["typedoc-plugin-markdown", "./scripts/typedoc-pages.mjs"],
  router: "module",
  entryFileName: "index",
  readme: "none",
  cleanOutputDir: true,
  disableSources: true,
  hidePageHeader: true,
  hideBreadcrumbs: true,
  parametersFormat: "table",
  interfacePropertiesFormat: "table",
  classPropertiesFormat: "table",
  typeAliasPropertiesFormat: "table",
  enumMembersFormat: "table",
  typeDeclarationFormat: "table",
  logLevel: "Warn",
};
