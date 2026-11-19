import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Mandate calls the agent above every thread the personal agent: "Personal
// agent" on the page, "the personal agent" in what models read, "personal"
// in its own code, files, tables, routes and events. "global" stays only
// where it means app-wide, not in one project.

const ROOT = path.resolve(import.meta.dir, "..");
const SAYS = /global|your agent|user's agent/i;
/** Uses of "global" that mean app-wide, taken out before a text is checked,
 *  so the rest of it still counts. */
const OTHER_MEANINGS = [
  /globalThis/g, /\bglobals\b/g, /globals\.css/g, /--global\b/g,
  /globalHttpClient|globalResourceRoot|shouldIgnoreGlobalEscape|defineGlobal/g,
  /\ba global (report|canvas)\b/gi, /\bUser and global memory\b/g, /\bsets a global\b/g,
  // The Skills view's line: whichever agent the owner talks to, a
  // manager or the personal agent, not the personal agent's old name.
  /\bask your agent: undo a change, go back to a revision, archive, restore or move it\b/g
];
/** Where "global" is a learned skill's scope (the one for every project,
 *  beside one project's): the word taken out there, the rest still checked. */
const SKILL_SCOPE_DIRS = ["src/server/modules/skills/", "src/client/routes/memory/skills/"];
/** What gets committed: a stray local file (a log, an export) is not Mandate's. */
const KINDS = /\.(ts|tsx|js|mjs|md|json|css|html|sh|sql|yml|txt|conf)$/;
/** Files named for the stylesheet of the same name. */
const NAMED_FOR_GLOBALS_CSS = new Set(["src/client/styles/globals.css", "tests/client/globals-css-tokens.test.ts"]);

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

/** Whether `text` still names the agent the old way once the other
 *  meanings are taken out. */
function says(text: string, rel = ""): boolean {
  let rest = text;
  for (const other of OTHER_MEANINGS) rest = rest.replace(other, "");
  if (SKILL_SCOPE_DIRS.some((dir) => rel.startsWith(dir))) rest = rest.replace(/\bglobal\b/gi, "");
  return SAYS.test(rest);
}

/** A settings search entry's hidden keywords: the old words find the new name. */
function isSearchKeywords(node: ts.Node): boolean {
  return ts.isStringLiteral(node) && ts.isPropertyAssignment(node.parent) && node.parent.name.getText() === "keywords";
}

test("no file or folder of Mandate's says global for the personal agent", () => {
  const named = ["src", "tests", "e2e", "scripts"]
    .flatMap((dir) => filesUnder(path.join(ROOT, dir)))
    .map(relative)
    .filter((file) => /global/i.test(file) && !NAMED_FOR_GLOBALS_CSS.has(file));
  expect(named).toEqual([]);
});

/** The bare word where it means app-wide: a resource's or canvas's owner
 *  kind (a value or a literal type), the dream's scope id, `declare global`,
 *  and the folder name handed to path.join. Anywhere else it is an old value. */
function isAppWideBare(node: ts.Node): boolean {
  if (!(ts.isStringLiteral(node) || ts.isIdentifier(node)) || node.text !== "global") return false;
  if (ts.isIdentifier(node)) return ts.isModuleDeclaration(node.parent) && node.parent.name === node;
  let up: ts.Node = node.parent;
  while (ts.isAsExpression(up) || ts.isSatisfiesExpression(up) || ts.isParenthesizedExpression(up) || ts.isLiteralTypeNode(up)) up = up.parent;
  const named = (ts.isPropertyAssignment(up) || ts.isPropertySignature(up)) ? up.name.getText() : null;
  if (named === "kind" || named === "scopeId") return true;
  return ts.isCallExpression(up) && up.expression.getText() === "path.join";
}

/** What a TypeScript file says the old way: its identifiers, strings and page text. */
function foundIn(rel: string, text: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    const words = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text
      : ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node) ? node.text
        : null;
    if (words !== null && !isSearchKeywords(node) && !isAppWideBare(node) && says(words, rel)) {
      found.push(`${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${words.trim().slice(0, 80)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What one file says: a prompt, skill, style or data file line by line, a
 *  source file through its parsed names and strings. A source file whose text
 *  never says the words has nothing to find — with every backslash taken out,
 *  so an escaped quote, an identity escape or a line continuation still
 *  counts, and any \\u or \\x escape parsed — and is not parsed: parsing all
 *  of src is what timed out under load. */
function problemsIn(rel: string, text: string): string[] {
  if (!/\.(ts|tsx)$/.test(rel)) {
    const found: string[] = [];
    text.split("\n").forEach((line, i) => {
      if (says(line, rel)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
    return found;
  }
  // A line continuation ends at any line terminator: CRLF, CR, LF, U+2028, U+2029.
  if (!SAYS.test(text.replace(/\\(?:\r\n|[\r\n\u2028\u2029])?/g, "")) && !/\\[ux]/.test(text)) return [];
  return foundIn(rel, text);
}

test("no identifier, string, page text or prompt in src names the personal agent global or Your agent", () => {
  const found: string[] = [];
  for (const file of filesUnder(path.join(ROOT, "src"))) found.push(...problemsIn(relative(file), fs.readFileSync(file, "utf8")));
  expect(found).toEqual([]);
});

test("a name written through an escape or a line continuation is still found", () => {
  const written = [
    "const label = 'user\\'s agent';",
    'const label = "g\\lobal agent";',
    'const label = "\\u0067lobal";',
    'const label = "\\x67lobal";',
    'const label = "Your \\\nagent";',
    'const label = "g\\\rlobal agent";',
    'const label = "g\\\r\nlobal agent";',
    'const label = "g\\\u2028lobal agent";',
    'const label = "g\\\u2029lobal agent";',
    "const globalAgent = 1;"
  ];
  for (const line of written) expect({ line, found: problemsIn("src/probe.ts", line).length > 0 }).toEqual({ line, found: true });
  expect(problemsIn("src/probe.ts", 'const label = "Personal agent";')).toEqual([]);
});

// The old values were the bare word: a scope compared as a string, a key
// named for it. Only the app-wide places may still say it.
test("a bare global that names the agent is found; one that means app-wide is not", () => {
  const finds = (text: string) => foundIn("x.ts", text).length;
  expect(finds('if (row.thread_scope === "global") return 1;')).toBe(1);
  expect(finds('const roles: Record<string, string> = { global: "x" };')).toBe(1);
  expect(finds('const owner = { kind: "global" as const };')).toBe(0);
  expect(finds('type Owner = { kind: "global" } | { kind: "project"; projectId: string };')).toBe(0);
  expect(finds('declare global { interface Window { x: number } }')).toBe(0);
  expect(finds('const dir = path.join(root, "global");')).toBe(0);
  expect(finds('const call = { scopeType: "memory", scopeId: "global" };')).toBe(0);
});

test("the app-wide meanings are taken out, not the whole text", () => {
  expect(says("Omit for a global canvas.")).toBe(false);
  expect(says("Omit for a global canvas; the global agent reads it.")).toBe(true);
  expect(says("Ask Your agent")).toBe(true);
  expect(says("via your personal agent")).toBe(false);
  expect(says("the user's personal agent")).toBe(false);
});
