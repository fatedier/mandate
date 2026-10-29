import * as path from "node:path";
import { resolveDataDir } from "./data-dir.js";

export type ResourceOwner =
  | { kind: "global" }
  | { kind: "project"; projectId: string };

type ResourceBucket = "agent" | "canvases" | "fit-leases" | "manager" | "tool-output";

export function resourcesRoot(dataDir = resolveDataDir()): string {
  return path.join(dataDir, "resources");
}

function globalResourceRoot(dataDir = resolveDataDir()): string {
  return path.join(resourcesRoot(dataDir), "global");
}

export function projectResourceRoot(projectId: string, dataDir = resolveDataDir()): string {
  return path.join(resourcesRoot(dataDir), "projects", segment(projectId));
}

export function resourceDir(owner: ResourceOwner, bucket: ResourceBucket, dataDir = resolveDataDir()): string {
  const root = owner.kind === "project"
    ? projectResourceRoot(owner.projectId, dataDir)
    : globalResourceRoot(dataDir);
  return path.join(root, bucket);
}

export function managerResourcesDir(dataDir = resolveDataDir()): string {
  return resourceDir({ kind: "global" }, "manager", dataDir);
}

/** The global agent's own working directory: its
 *  notes are in `notes/`, the rest is its to use. */
export function globalAgentDir(dataDir = resolveDataDir()): string {
  return resourceDir({ kind: "global" }, "agent", dataDir);
}

export function canvasSourceFilePath(input: {
  canvasId: string;
  owner: ResourceOwner;
  fileName?: string;
  dataDir?: string;
}): string {
  return path.join(
    resourceDir(input.owner, "canvases", input.dataDir),
    segment(input.canvasId),
    input.fileName ?? "index.html"
  );
}

export function toolOutputDir(input: {
  owner: ResourceOwner;
  threadId: string;
  dataDir?: string;
}): string {
  return path.join(
    resourceDir(input.owner, "tool-output", input.dataDir),
    segment(input.threadId)
  );
}

/** A name made safe for one path segment: a thread's or a canvas's folder. */
export function segment(value: string): string {
  const out = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return out || "unknown";
}
