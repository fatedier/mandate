import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertReadInScope } from "../src/server/modules/agent/tool-scope.js";
import { withTempDataDir } from "./helpers/fixtures.js";

function ctx(wd: string) {
  return {
    kind: "worker" as const,
    feature: { workingDir: wd },
    project: { workingDir: wd }
  } as any;
}

function outOfScopeMemoryPath() {
  return path.join(path.parse(os.tmpdir()).root, "__mandate_out_of_scope_memory__", ".mandate", "memories", "global", "memory.md");
}

test("assertReadInScope: rejects memory files outside project and scratch scope", () => {
  const { restore } = withTempDataDir();
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  try {
    const memPath = outOfScopeMemoryPath();
    expect(() => assertReadInScope(memPath, ctx(wd))).toThrow(/outside worker scope/);
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
    restore();
  }
});

test("assertReadInScope: still rejects /etc/passwd (out-of-scope)", () => {
  const { restore } = withTempDataDir();
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  try {
    expect(() => assertReadInScope("/etc/passwd", ctx(wd))).toThrow();
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
    restore();
  }
});

test("assertReadInScope: rejects memories root itself outside project and scratch scope", () => {
  const { restore } = withTempDataDir();
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  try {
    const memRoot = path.dirname(outOfScopeMemoryPath());
    expect(() => assertReadInScope(memRoot, ctx(wd))).toThrow(/outside worker scope/);
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
    restore();
  }
});

test("assertReadInScope: system temp dir is available as scratch space", () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  try {
    const tmpFile = path.join(os.tmpdir(), "mandate-scratch.txt");
    const out = assertReadInScope(tmpFile, ctx(wd));
    expect(out).toBe(path.resolve(tmpFile));
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});

test("assertReadInScope: project-scope path still works", () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  try {
    const inside = path.join(wd, "src/foo.ts");
    const out = assertReadInScope(inside, ctx(wd));
    expect(out).toBe(inside);
  } finally { fs.rmSync(wd, { recursive: true, force: true }); }
});
