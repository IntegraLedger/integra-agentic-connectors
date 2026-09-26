import { resolve, sep } from "node:path";

/** The parts of a hast node these plugins read or write. */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  data?: { meta?: string };
  children?: HastNode[];
}

interface FileLike {
  path?: string;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function codeOf(pre: HastNode): HastNode | undefined {
  if (pre.type !== "element" || pre.tagName !== "pre") return undefined;
  const code = pre.children?.[0];
  return code?.type === "element" && code.tagName === "code" ? code : undefined;
}

function languageOf(code: HastNode): string | undefined {
  const classes = code.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  const found = classes.find((c) => typeof c === "string" && c.startsWith("language-"));
  return typeof found === "string" ? found.slice("language-".length) : undefined;
}

/**
 * Replaces each ```` ```mermaid ```` block with a `<Mermaid chart="…" />` element, which the
 * page renders as a diagram. Runs before code highlighting.
 */
export function rehypeMermaid() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      const children = node.children ?? [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (!child) continue;
        const code = codeOf(child);
        if (code && languageOf(code) === "mermaid") {
          children[i] = {
            type: "mdxJsxFlowElement",
            name: "Mermaid",
            attributes: [{ type: "mdxJsxAttribute", name: "chart", value: textOf(code).trimEnd() }],
            children: [],
          } as HastNode;
        } else {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

/**
 * Adds `no-check` to the meta of every code block in files under the given directories, so
 * the type-checking transformer leaves them alone. Runs before code highlighting.
 */
export function rehypeUncheckedUnder(dirs: string[]) {
  const roots = dirs.map((d) => resolve(d) + sep);
  return (tree: HastNode, file: FileLike) => {
    if (!file.path) return;
    const path = resolve(file.path);
    if (!roots.some((root) => path.startsWith(root))) return;
    const visit = (node: HastNode) => {
      const code = codeOf(node);
      if (code) {
        const meta = code.data?.meta ?? "";
        code.data = { ...code.data, meta: meta.length > 0 ? `${meta} no-check` : "no-check" };
        return;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

/** Whether a code block's meta string carries the given flag as a whole word. */
export function hasMetaFlag(meta: unknown, flag: string): boolean {
  return typeof meta === "string" && meta.split(/\s+/).includes(flag);
}
