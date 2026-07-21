import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertReadInScope, assertWriteInScope, type AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { withTempDataDir } from "./helpers/fixtures.js";

function withDataDir(dataDir: string): () => void {
  const old = process.env.MANDATE_DATA_DIR;
  process.env.MANDATE_DATA_DIR = dataDir;
  return () => {
    if (old === undefined) delete process.env.MANDATE_DATA_DIR;
    else process.env.MANDATE_DATA_DIR = old;
  };
}

test("worker scope: read = write = inside feature/project dirs plus scratch", () => {
  const { dataDir, restore } = withTempDataDir();
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-feat-"));
  const scope: AgentScope = { kind: "worker", feature: { workingDir: wd }, project: { workingDir: wd } };
  try {
    assertReadInScope(path.join(wd, "a.txt"), scope);
    assertWriteInScope(path.join(wd, "a.txt"), scope);
    assertReadInScope(path.join(dataDir, "scratch.txt"), scope);
    assertWriteInScope(path.join(dataDir, "scratch.txt"), scope);
    expect(() => assertReadInScope("/etc/passwd", scope)).toThrow();
    expect(() => assertWriteInScope("/etc/passwd", scope)).toThrow();
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
    restore();
  }
});

test("manager scope: read and write across project dirs plus manager dir and scratch", () => {
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

    expect(() => assertReadInScope(outside, scope)).toThrow(/outside manager read scope/);
    expect(() => assertWriteInScope(outside, scope)).toThrow(/not writable in manager scope/);
    expect(() => assertReadInScope("/etc/passwd", scope)).toThrow();
  } finally {
    fs.rmSync(projA, { recursive: true, force: true });
    fs.rmSync(projB, { recursive: true, force: true });
    restore();
  }
});

test("worker and manager scopes allow Mandate data dir read and write", () => {
  const dataDir = path.join(os.homedir(), ".mandate-scope-test");
  const restore = withDataDir(dataDir);
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-feat-"));
  const managerDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-manager-"));
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
    fs.rmSync(wd, { recursive: true, force: true });
    fs.rmSync(managerDir, { recursive: true, force: true });
    restore();
  }
});
