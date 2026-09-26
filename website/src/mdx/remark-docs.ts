import { existsSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

/** The parts of an mdast node these plugins read or write. */
interface MdastNode {
  type: string;
  url?: string;
  depth?: number;
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, string> };
  children?: MdastNode[];
}

interface FileLike {
  path?: string;
}

function walk(node: MdastNode, visit: (node: MdastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/**
 * Removes a page's leading `# Title` heading. The page layout renders the frontmatter title
 * as the page heading, and the Markdown files repeat it on their first line for GitHub.
 */
export function remarkStripLeadingTitle() {
  return (tree: MdastNode) => {
    const children = tree.children ?? [];
    const first = children.findIndex((n) => n.type !== "yaml" && n.type !== "toml");
    const node = children[first];
    if (node?.type === "heading" && node.depth === 1) children.splice(first, 1);
  };
}

/**
 * Turns each raw `<a id="…"></a>` into an anchor element. Markdown pages are compiled without
 * raw HTML, and the API pages mark table rows with these anchors.
 */
export function remarkHtmlAnchors() {
  const anchor = (node: MdastNode, id: string) => {
    node.type = "text";
    node.value = "";
    node.data = { hName: "a", hProperties: { id } };
  };
  return (tree: MdastNode) => {
    walk(tree, (parent) => {
      const children = parent.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const node = children[i];
        if (node?.type !== "html" || typeof node.value !== "string") continue;
        const whole = /^<a id="([^"<>]+)"><\/a>$/.exec(node.value.trim());
        if (whole?.[1]) {
          anchor(node, whole[1]);
          continue;
        }
        // Inline HTML arrives as separate opening and closing tags.
        const open = /^<a id="([^"<>]+)">$/.exec(node.value.trim());
        const next = children[i + 1];
        if (open?.[1] && next?.type === "html" && next.value?.trim() === "</a>") {
          anchor(node, open[1]);
          children.splice(i + 1, 1);
        }
      }
    });
  };
}

export interface DocLinksOptions {
  /** Absolute path of the documentation tree. */
  docsDir: string;
  /** Absolute path of the folder that is the repository's root. */
  repoRoot: string;
  /** `https://github.com/<owner>/<repo>` */
  githubUrl: string;
  /** The branch links to files outside the documentation tree point at. */
  branch: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Rewrites relative links in the documentation's Markdown:
 *
 * - a link to a `.md` page inside the documentation tree becomes the page's site URL
 *   (`../concepts/binding.md#x` becomes `/concepts/binding#x`, an `index.md` its folder);
 * - a link to anything else becomes its GitHub URL on `branch`, relative to `repoRoot`.
 *
 * Absolute URLs, root-relative paths and in-page `#` links are left as they are. A link to a
 * page that does not exist in the documentation tree fails the build; a missing target
 * outside the tree is reported and still rewritten.
 */
export function remarkDocLinks(options: DocLinksOptions) {
  const docsDir = resolve(options.docsDir);
  const repoRoot = resolve(options.repoRoot);

  const rewrite = (url: string, from: string): string => {
    if (url === "" || SCHEME.test(url) || url.startsWith("/") || url.startsWith("#")) return url;
    const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
    const pathPart = match?.[1] ?? url;
    const query = match?.[2] ?? "";
    const hash = match?.[3] ?? "";
    const target = resolve(dirname(from), decodeURI(pathPart));
    const where = relative(repoRoot, from);
    const inDocs = target === docsDir || target.startsWith(docsDir + sep);

    if (inDocs && target.endsWith(".md")) {
      if (!existsSync(target)) {
        throw new Error(`${where}: the link ${url} names a page that does not exist`);
      }
      const parts = relative(docsDir, target).slice(0, -".md".length).split(sep);
      if (parts.at(-1) === "index") parts.pop();
      return `/${parts.map(encodeURIComponent).join("/")}${hash}`;
    }

    const inRepo = relative(repoRoot, target);
    if (inRepo.startsWith("..")) {
      throw new Error(`${where}: the link ${url} leaves the repository`);
    }
    let kind = "blob";
    if (existsSync(target)) {
      if (statSync(target).isDirectory()) kind = "tree";
    } else {
      console.warn(`${where}: the link ${url} names ${inRepo}, which does not exist here`);
    }
    const path = inRepo.split(sep).map(encodeURIComponent).join("/");
    return `${options.githubUrl}/${kind}/${options.branch}/${path}${query}${hash}`;
  };

  return (tree: MdastNode, file: FileLike) => {
    const from = file.path;
    if (!from) return;
    walk(tree, (node) => {
      if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
        node.url = rewrite(node.url, resolve(from));
      }
    });
  };
}
