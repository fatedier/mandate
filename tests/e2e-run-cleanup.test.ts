import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tempDir } from "./helpers/temp.js";
import { newRunId } from "../e2e/helpers/diagnostics.js";

/** e2e diagnostics are evidence for a failure. A passing run's are deleted;
 *  before this, every run left one directory per worker behind and the
 *  bind-mounted directory grew large enough that full
 *  runs failed timing-shaped tests. */
const REPO = path.join(import.meta.dir, "..");
const RUNNER = path.join(REPO, "e2e", "run.ts");
const DIAGNOSTICS = path.join(REPO, "e2e", "helpers", "diagnostics.ts");

function fixture(files: Record<string, "pass" | "fail">, unit: Record<string, "pass" | "fail"> = {}): string {
  const dir = tempDir("md-e2e-run-");
  fs.mkdirSync(path.join(dir, "tests"));
  fs.writeFileSync(path.join(dir, "tests", "setup.ts"), "");
  fs.mkdirSync(path.join(dir, "e2e"));
  for (const [name, outcome] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, "e2e", `${name}.test.ts`), [
      `import { expect, test } from "bun:test";`,
      `import * as fs from "node:fs";`,
      `import { artifactDir } from ${JSON.stringify(DIAGNOSTICS)};`,
      `test("${name}", () => {`,
      `  fs.writeFileSync(artifactDir("${name}") + "/log.txt", "evidence");`,
      `  expect("${outcome}").toBe("pass");`,
      `});`
    ].join("\n"));
  }
  for (const [name, outcome] of Object.entries(unit)) {
    fs.writeFileSync(path.join(dir, "tests", `${name}.test.ts`),
      `import { expect, test } from "bun:test";\ntest("${name}", () => { expect("${outcome}").toBe("pass"); });\n`);
  }
  return dir;
}

async function run(cwd: string, files: string[], flags: string[] = []): Promise<number> {
  const proc = Bun.spawn(["bun", RUNNER, ...flags, ...files.map((f) => `e2e/${f}.test.ts`)], { cwd, stdout: "ignore", stderr: "ignore" });
  return proc.exited;
}

const runDirs = (cwd: string) => fs.readdirSync(path.join(cwd, "e2e", ".artifacts"));

test("a run that passes leaves no diagnostics behind", async () => {
  const cwd = fixture({ a: "pass", b: "pass" });
  expect(await run(cwd, ["a", "b"])).toBe(0);
  expect(runDirs(cwd)).toEqual([]);
}, 30_000);

test("a run that fails keeps one directory for the whole run, with every worker's evidence", async () => {
  const cwd = fixture({ a: "pass", b: "fail" });
  expect(await run(cwd, ["a", "b"])).not.toBe(0);
  const dirs = runDirs(cwd);
  expect(dirs).toHaveLength(1);
  expect(fs.readdirSync(path.join(cwd, "e2e", ".artifacts", dirs[0]!)).sort()).toEqual(["a", "b"]);
}, 30_000);

test("options alone keep the run to e2e/", async () => {
  const cwd = fixture({ a: "pass" }, { unit: "fail" });
  expect(await run(cwd, [], ["--timeout=30000"])).toBe(0);
});

test("two runs started in the same millisecond get different directories", () => {
  const now = Date.now;
  Date.now = () => 1_790_000_000_000;
  try {
    const ids = new Set(Array.from({ length: 100 }, () => newRunId()));
    expect(ids.size).toBe(100);
  } finally {
    Date.now = now;
  }
});


// Slowest files first: the run reads e2e/timings.json; --update-timings
// writes what it measured where the container lets it out, e2e/.artifacts.
test("--update-timings writes each file's time to e2e/.artifacts, merged with e2e/timings.json, which the run reads", async () => {
  const cwd = fixture({ a: "pass", b: "pass" });
  fs.writeFileSync(path.join(cwd, "e2e", "timings.json"), JSON.stringify({ version: 1, files: { "e2e/elsewhere.test.ts": 4200 } }));
  expect(await run(cwd, [], ["--update-timings"])).toBe(0);
  const written = JSON.parse(fs.readFileSync(path.join(cwd, "e2e", ".artifacts", "e2e-timings.json"), "utf8")) as { files: Record<string, number> };
  expect(Object.keys(written.files).sort()).toEqual(["e2e/a.test.ts", "e2e/b.test.ts", "e2e/elsewhere.test.ts"]);
  // The committed file is left as it was.
  expect(JSON.parse(fs.readFileSync(path.join(cwd, "e2e", "timings.json"), "utf8")).files).toEqual({ "e2e/elsewhere.test.ts": 4200 });
}, 30_000);
