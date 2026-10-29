import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDataDir, worktreePathFor } from "../src/server/platform/fs/data-dir.js";
import {
  canvasSourceFilePath,
  managerResourcesDir,
  projectResourceRoot,
  resourceDir,
  resourcesRoot,
  toolOutputDir
} from "../src/server/platform/fs/resources.js";

// These tests set and unset the variable to say what resolveDataDir does with
// it. What the test process had is put back after each: left unset, every
// later test in this process would resolve the REAL data dir (tests/setup.ts
// gives the process a scratch one).
let processDataDir: string | undefined;
beforeEach(() => { processDataDir = process.env.MANDATE_DATA_DIR; });
afterEach(() => {
  if (processDataDir === undefined) delete process.env.MANDATE_DATA_DIR;
  else process.env.MANDATE_DATA_DIR = processDataDir;
});

// A unit test once reached the bash tool's default runner, which
// writes a shell snapshot into the data dir. With nothing set, that was the
// real ~/.mandate, and the running Mandate there sources the file before
// every command. The preload (tests/setup.ts) now gives each test process a
// data dir of its own, so a default that resolves it cannot reach the real one.
test("a test process resolves the data dir to a scratch dir of its own, never the real one", () => {
  const dir = resolveDataDir();
  expect(dir).not.toBe(path.join(os.homedir(), ".mandate"));
  expect(path.basename(dir).startsWith("mandate-test-data-")).toBe(true);
  expect([os.tmpdir(), fs.realpathSync(os.tmpdir())].some((tmp) => dir.startsWith(tmp))).toBe(true);
  expect(fs.statSync(dir).isDirectory()).toBe(true);
  // What production's snapshot and the managers' directory would resolve to.
  expect(path.join(dir, "shell-snapshots").startsWith(dir)).toBe(true);
  expect(managerResourcesDir().startsWith(dir)).toBe(true);
});

test("resolveDataDir: defaults to ~/.mandate", () => {
  delete process.env.MANDATE_DATA_DIR;
  expect(resolveDataDir()).toBe(path.join(os.homedir(), ".mandate"));
});

test("resolveDataDir: respects MANDATE_DATA_DIR env var (absolute)", () => {
  process.env.MANDATE_DATA_DIR = "/tmp/custom-md";
  expect(resolveDataDir()).toBe("/tmp/custom-md");
  delete process.env.MANDATE_DATA_DIR;
});

test("resolveDataDir: expands leading ~ in env var", () => {
  process.env.MANDATE_DATA_DIR = "~/altmd";
  expect(resolveDataDir()).toBe(path.join(os.homedir(), "altmd"));
  delete process.env.MANDATE_DATA_DIR;
});

test("worktreePathFor: <dataDir>/worktrees/<sessionName>/<branchSanitized>", () => {
  process.env.MANDATE_DATA_DIR = "/tmp/x";
  expect(worktreePathFor("md-my_app", "feature_x")).toBe("/tmp/x/worktrees/md-my_app/feature_x");
  delete process.env.MANDATE_DATA_DIR;
});

test("resource paths are grouped by global/project owner", () => {
  const dataDir = "/tmp/md-data";
  expect(resourcesRoot(dataDir)).toBe("/tmp/md-data/resources");
  expect(managerResourcesDir(dataDir)).toBe("/tmp/md-data/resources/global/manager");
  expect(projectResourceRoot("proj/1", dataDir)).toBe("/tmp/md-data/resources/projects/proj_1");
  expect(resourceDir({ kind: "project", projectId: "proj/1" }, "canvases", dataDir))
    .toBe("/tmp/md-data/resources/projects/proj_1/canvases");
  expect(resourceDir({ kind: "global" }, "fit-leases", dataDir))
    .toBe("/tmp/md-data/resources/global/fit-leases");
  expect(canvasSourceFilePath({
    canvasId: "cnv/1",
    owner: { kind: "project", projectId: "proj/1" },
    dataDir
  })).toBe("/tmp/md-data/resources/projects/proj_1/canvases/cnv_1/index.html");
  expect(canvasSourceFilePath({
    canvasId: "cnv/1",
    owner: { kind: "project", projectId: "proj/1" },
    fileName: "spec.json",
    dataDir
  })).toBe("/tmp/md-data/resources/projects/proj_1/canvases/cnv_1/spec.json");
  expect(toolOutputDir({
    owner: { kind: "global" },
    threadId: "thr/1",
    dataDir
  })).toBe("/tmp/md-data/resources/global/tool-output/thr_1");
});
