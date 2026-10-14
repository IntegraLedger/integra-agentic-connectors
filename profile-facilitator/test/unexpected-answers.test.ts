// x402's `unexpected_verify_error` and `unexpected_settle_error` say that a failure inside the facilitator, its node or
// its store stopped a check or a settlement, and src/unexpected.ts gives each only once the operator log has its entry.
// This test reads the facilitator's source as its build compiles it (tsconfig.json), with the TypeScript compiler's
// API, and finds every string literal that spells either answer. Outside src/unexpected.ts, one in a value position is
// an answer given without its entry. A literal type, such as a member of the `InvalidReason` union, gives no answer,
// and comments and docblocks hold no string literal.
import { fileURLToPath } from "node:url";
import { isLiteralTypeNode, isNoSubstitutionTemplateLiteral, isStringLiteral, type Node } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { beforeAll, describe, expect, it } from "vitest";

const ANSWERS = ["unexpected_settle_error", "unexpected_verify_error"];
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const HELPER = "src/unexpected.ts";

interface Spelling {
  /** The file, from the package's root. */
  file: string;
  line: number;
  text: string;
  /** A literal type: the answer's name in a type, not an answer given. */
  type: boolean;
}

/** The source files the build compiles, from the package's root, and every spelling of an answer in them. */
function read(): { files: string[]; spellings: Spelling[] } {
  const api = new API({ cwd: PACKAGE });
  try {
    const config = `${PACKAGE}tsconfig.json`;
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    if (project === undefined) throw new Error(`no project for ${config}`);
    const files = project.program.getSourceFileNames().filter((f) => f.startsWith(`${PACKAGE}src/`));
    const spellings: Spelling[] = [];
    for (const name of files) {
      const file = project.program.getSourceFile(name);
      if (file === undefined) throw new Error(`no source file for ${name}`);
      const visit = (node: Node): void => {
        if ((isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) && ANSWERS.includes(node.text)) {
          spellings.push({
            file: name.slice(PACKAGE.length),
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            text: node.text,
            type: isLiteralTypeNode(node.parent),
          });
        }
        node.forEachChild(visit);
      };
      file.forEachChild(visit);
    }
    return { files: files.map((f) => f.slice(PACKAGE.length)), spellings };
  } finally {
    api.close();
  }
}

describe("the unexpected answers", () => {
  let source: ReturnType<typeof read>;
  beforeAll(() => {
    source = read();
  });

  it("are given as values only in src/unexpected.ts, which writes each one's operator entry first", () => {
    const values = source.spellings.filter((s) => !s.type);
    expect(values.filter((s) => s.file !== HELPER)).toEqual([]);
    // The read reached the code: every rail's file, both answers given in the helper, and the union's literal type.
    expect(source.files).toEqual(expect.arrayContaining(["src/index.ts", "src/tron.ts", "src/polkadot.ts", HELPER]));
    expect([...new Set(values.map((s) => s.text))].sort()).toEqual(ANSWERS);
    expect(source.spellings.filter((s) => s.type).map((s) => [s.file, s.text])).toEqual([
      ["src/answers.ts", "unexpected_verify_error"],
    ]);
  });
});
