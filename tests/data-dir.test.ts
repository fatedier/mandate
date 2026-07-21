import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDataDir, worktreesRoot, worktreePathFor } from "../src/server/platform/fs/data-dir.js";
import {
  canvasSourceFilePath,
  managerResourcesDir,
  projectResourceRoot,
  resourceDir,
  resourcesRoot,
  toolOutputDir
} from "../src/server/platform/fs/resources.js";

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

test("worktreesRoot: <dataDir>/worktrees", () => {
  delete process.env.MANDATE_DATA_DIR;
  expect(worktreesRoot()).toBe(path.join(os.homedir(), ".mandate", "worktrees"));
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
