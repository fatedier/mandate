import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertReadInScope, assertWriteInScope, type AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { withTempDataDir } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";

function withDataDir(dataDir: string): () => void {
  const old = process.env.MANDATE_DATA_DIR;
  process.env.MANDATE_DATA_DIR = dataDir;
  return () => {
    if (old === undefined) delete process.env.MANDATE_DATA_DIR;
    else process.env.MANDATE_DATA_DIR = old;
  };
}

test("manager scope: reads and writes any path, its own dir, projects and anything else", () => {
  const { dataDir, restore } = withTempDataDir();
  const projA = fs.mkdtempSync(path.join(os.homedir(), ".md-pa-"));
  const projB = fs.mkdtempSync(path.join(os.homedir(), ".md-pb-"));
  const managerDir = path.join(dataDir, "overview");
  const outside = path.join(path.parse(os.tmpdir()).root, "__mandate_disallowed__", "outside.txt");
  const scope: AgentScope = {
    kind: "manager",
    managerDir,
    projectWorkingDirs: [projA, projB]
  };
  try {
    assertReadInScope(path.join(projA, "src/index.ts"), scope);
    assertReadInScope(path.join(projB, "README.md"), scope);
    assertReadInScope(path.join(managerDir, "report.md"), scope);
    assertReadInScope(path.join(dataDir, "scratch.txt"), scope);

    assertWriteInScope(path.join(managerDir, "report.md"), scope);
    assertWriteInScope(path.join(dataDir, "scratch.txt"), scope);
    assertWriteInScope(path.join(projA, "src/index.ts"), scope);

    // No roots: a path outside every one is read and written as given.
    expect(assertReadInScope(outside, scope)).toBe(outside);
    expect(assertWriteInScope(outside, scope)).toBe(outside);
    expect(assertReadInScope("/etc/passwd", scope)).toBe("/etc/passwd");
  } finally {
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
    restore();
  }
});

test("worker and manager scopes allow Mandate data dir read and write", () => {
  const dataDir = path.join(os.homedir(), ".mandate-scope-test");
  const restore = withDataDir(dataDir);
  const wd = tempDir("md-feat-");
  const managerDir = tempDir("md-manager-");
  const dataPath = path.join(dataDir, "resources", "global", "tool-output", "result.txt");
  try {
    const featureScope: AgentScope = {
      kind: "worker",
      feature: { workingDir: wd },
      project: { workingDir: wd }
    };
    const managerScope: AgentScope = {
      kind: "manager",
      managerDir,
      projectWorkingDirs: [wd]
    };

    expect(assertReadInScope(dataPath, featureScope)).toBe(path.resolve(dataPath));
    expect(assertWriteInScope(dataPath, featureScope)).toBe(path.resolve(dataPath));
    expect(assertReadInScope(dataPath, managerScope)).toBe(path.resolve(dataPath));
    expect(assertWriteInScope(dataPath, managerScope)).toBe(path.resolve(dataPath));
  } finally {
    restore();
  }
});

test("worker scope: the system temp dir is scratch space", () => {
  const wd = tempDir("md-wd-");
  const tmpFile = path.join(os.tmpdir(), "mandate-scratch.txt");
  const scope: AgentScope = { kind: "worker", feature: { workingDir: wd }, project: { workingDir: wd } };
  expect(assertReadInScope(tmpFile, scope)).toBe(path.resolve(tmpFile));
});

test("worker scope: its project and feature dirs are in scope wherever they live", () => {
  // Outside every temp root, so only the worker's own roots can admit them:
  // a fixture under tmp passes whether or not they are counted.
  const project = fs.mkdtempSync(path.join(os.homedir(), ".md-proj-"));
  const worktree = fs.mkdtempSync(path.join(os.homedir(), ".md-wt-"));
  const scope: AgentScope = { kind: "worker", feature: { workingDir: worktree }, project: { workingDir: project } };
  try {
    for (const dir of [project, worktree]) {
      expect(assertReadInScope(path.join(dir, "a.txt"), scope)).toBe(path.join(dir, "a.txt"));
      expect(assertWriteInScope(path.join(dir, "a.txt"), scope)).toBe(path.join(dir, "a.txt"));
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
