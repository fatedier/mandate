import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Mandate calls the agent that works on one task a worker, in what people
// and models read and in its own code, files, tables, routes and events.
// "feature" stays only where it means something else.

const ROOT = path.resolve(import.meta.dir, "..");
const SAYS = /feature/i;
/** Phrases where "feature" means something else: a git branch and a
 *  product's features. Taken out before a text is checked, so the rest of
 *  it still counts. */
const OTHER_MEANINGS = [/feature branch(es)?/gi, /listing features/g];
/** What gets committed: a stray local file (a log, an export) is not Mandate's. */
const KINDS = /\.(ts|tsx|js|mjs|md|json|css|html|sh|sql|yml|txt|conf)$/;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile() && KINDS.test(entry.name)) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(ROOT, file);

/** Whether `text` still says feature once the other meanings are taken out. */
function says(text: string): boolean {
  let rest = text;
  for (const other of OTHER_MEANINGS) rest = rest.replace(other, "");
  return SAYS.test(rest);
}

test("no file or folder of Mandate's says feature", () => {
  const named = ["src", "tests", "e2e", "scripts"]
    .flatMap((dir) => filesUnder(path.join(ROOT, dir)))
    .map(relative)
    .filter((file) => SAYS.test(file));
  expect(named).toEqual([]);
});

test("no identifier, string, page text or prompt in src says feature for a worker", () => {
  const found: string[] = [];
  for (const file of filesUnder(path.join(ROOT, "src"))) {
    const rel = relative(file);
    const text = fs.readFileSync(file, "utf8");
    if (!/\.(ts|tsx)$/.test(file)) {
      // Prompts, styles, page shells and data: every line is read.
      text.split("\n").forEach((line, i) => {
        if (says(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
      continue;
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      const words = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text
        : ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text
          : null;
      if (words !== null && says(words)) {
        found.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${words.trim().slice(0, 80)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(found).toEqual([]);
});

test("the other meanings are taken out, not the whole text", () => {
  expect(says("Create a feature branch for this feature.")).toBe(true);
  expect(says("Agents may push their own feature branches.")).toBe(false);
});

// "f" was a feature's row: in SQL the workers table is named for what it is.
test("no SQL in src names the workers table f", () => {
  const found: string[] = [];
  for (const file of filesUnder(path.join(ROOT, "src"))) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // The table named f, or a column read through f (SQL's snake_case:
      // a row's properties in code are camelCase).
      if (/(?:\b(?:from|join)\s+|`)workers\s+(?:as\s+)?ff?\b|\bff?\.[a-z]+_[a-z_]+\b/.test(line)) found.push(`${relative(file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  expect(found).toEqual([]);
});
