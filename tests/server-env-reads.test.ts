import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "bun:test";
import ts from "typescript";
import { sourceFiles } from "./helpers/source-files.js";

// The server's settings come from config.json and the `mandate serve` flags.
// Every use of the environment under src/server is one of these, each with
// its reason; anything else is a setting read from the environment.
const ALLOWED: Array<[use: string, why: string]> = [
  ["server.ts: reads MANDATE_DATA_DIR", "--data-dir says where config.json is"],
  ["platform/fs/data-dir.ts: reads MANDATE_DATA_DIR", "where config.json is"],
  ["platform/process/shell-snapshot.ts: reads SHELL", "the user's login shell, the system's, not a setting"],
  ["platform/process/shell-snapshot.ts: passes it whole", "a child's environment"]
];
const SERVER = path.join(import.meta.dir, "..", "src", "server");

/** `process.env`, `Bun.env`, `import.meta.env` (Bun's alias), and the names
 *  an import of node:process binds to it or to the module. */
function envUses(source: ts.SourceFile): ts.Node[] {
  const modules = new Set(["process", "Bun"]);
  const envNames = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!["process", "node:process"].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) modules.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "env") envNames.add(element.name.text);
    }
  }
  const isModule = (node: ts.Node) => ts.isIdentifier(node) && modules.has(node.text);
  const uses: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === "env"
      && (isModule(node.expression) || (ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword))) uses.push(node);
    else if (ts.isElementAccessExpression(node) && isModule(node.expression)
      && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "env") uses.push(node);
    else if (ts.isIdentifier(node) && envNames.has(node.text) && !ts.isImportSpecifier(node.parent)) uses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

/** What the code does with it: reads a name (through `??`, `||` and
 *  parentheses, as `(given ?? process.env).NAME`), passes it on whole, or
 *  something else. */
function whatItDoes(node: ts.Node): string {
  let at = node;
  while (ts.isParenthesizedExpression(at.parent)
    || (ts.isBinaryExpression(at.parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(at.parent.operatorToken.kind))) at = at.parent;
  const parent = at.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === at) return `reads ${parent.name.text}`;
  if (ts.isElementAccessExpression(parent) && parent.expression === at) {
    return ts.isStringLiteralLike(parent.argumentExpression) ? `reads ${parent.argumentExpression.text}` : "reads a computed name";
  }
  if (ts.isPropertyAssignment(parent) || ts.isSpreadAssignment(parent)) return "passes it whole";
  return `uses it as \`${parent.getText().slice(0, 60)}\``;
}

test("every use of the environment under src/server is a listed one", () => {
  const found: string[] = [];
  for (const file of sourceFiles(SERVER, /\.ts$/, 300)) {
    const text = fs.readFileSync(file, "utf8");
    // Every way in names `env`: the rest need no parse.
    if (!text.includes("env")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const at = path.relative(SERVER, file).split(path.sep).join("/");
    for (const node of envUses(source)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      found.push(`${at}: ${whatItDoes(node)} (line ${line})`);
    }
  }
  const bare = (use: string) => use.replace(/ \(line \d+\)$/, "");
  const listed = new Set(ALLOWED.map(([use]) => use));
  // Nothing else, each named where it is; then each listed use exactly once.
  expect(found.filter((use) => !listed.has(bare(use)))).toEqual([]);
  expect(found.map(bare).sort()).toEqual([...listed].sort());
});
