import { expect, test } from "bun:test";
import { ESLint } from "eslint";

// The server runs on one thread: a synchronous process call holds every
// request until the command ends, so ESLint refuses one anywhere in
// src/server, however it is written.

const eslint = new ESLint({ cwd: process.cwd() });

async function problems(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((message) => message.severity === 2).map((message) => message.ruleId ?? "parse");
}

test.each([
  ["a named import", 'import { spawnSync } from "node:child_process";\nexport const run = spawnSync;\n'],
  ["the old module name", 'import { execSync } from "child_process";\nexport const run = execSync;\n'],
  ["a default import", 'import cp from "node:child_process";\nexport const run = () => cp.spawnSync("git", []);\n'],
  ["a namespace import", 'import * as cp from "node:child_process";\nexport const run = () => cp.execFileSync("git", []);\n'],
  ["Bun's global", 'export const run = () => Bun.spawnSync(["git"]);\n'],
  ["Bun's module", 'import { spawnSync } from "bun";\nexport const run = spawnSync;\n'],
  ["a destructured alias", 'const { spawnSync: run } = Bun;\nexport const invoke = () => run(["git"]);\n'],
  ["a literal index", 'export const run = () => Bun["spawnSync"](["git"]);\n']
])("a synchronous process call written as %s is refused in src/server", async (_form, code) => {
  for (const filePath of ["src/server/modules/zz-lint-probe.ts", "src/server/platform/process/zz-lint-probe.ts"]) {
    expect([filePath, (await problems(code, filePath)).length > 0]).toEqual([filePath, true]);
  }
});

test("an async spawn stays allowed", async () => {
  const code = 'import { spawn } from "node:child_process";\nexport const run = () => spawn("git", []);\n';
  expect(await problems(code, "src/server/platform/process/zz-lint-probe.ts")).toStrictEqual([]);
});
