import type { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourceDir, resourcesRoot, segment, type ResourceOwner } from "../fs/resources.js";
import { resolveDataDir } from "../fs/data-dir.js";
import { logError } from "../logger.js";
import { NOT_IDLE_SUMMARY } from "./activity-sql.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every owner whose resources hold tool output: the global one, and each project's. */
function owners(dataDir: string): ResourceOwner[] {
  const projects = path.join(resourcesRoot(dataDir), "projects");
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No project has resources yet.
  }
  return [{ kind: "global" }, ...ids.map((projectId): ResourceOwner => ({ kind: "project", projectId }))];
}

/** A thread's tool-output folders, under every owner: what its deletion removes. */
export function toolOutputDirsOfThread(threadId: string, dataDir: string = resolveDataDir()): string[] {
  return owners(dataDir).map((owner) => path.join(resourceDir(owner, "tool-output", dataDir), segment(threadId)));
}

/**
 * Tool output files (spooled large results, background commands' output)
 * go when their thread has been quiet for `inactiveDays`, or when they are
 * older than `maxAgeDays` whatever the thread does; a running command's file
 * stays until it ends. A folder whose thread is gone goes. Empty folders go.
 */
export function sweepToolOutputs(input: {
  db: Database;
  dataDir?: string;
  now: Date;
  /** Output files of running commands: kept. */
  runningPaths: readonly string[];
  inactiveDays?: number;
  maxAgeDays?: number;
}): { deleted: number } {
  const dataDir = input.dataDir ?? resolveDataDir();
  const quietBefore = input.now.getTime() - (input.inactiveDays ?? 7) * DAY_MS;
  const oldBefore = input.now.getTime() - (input.maxAgeDays ?? 30) * DAY_MS;
  const running = new Set(input.runningPaths.map((p) => path.resolve(p)));
  // A folder is named by its thread's id made safe for a path (segment), which
  // is not always the id itself (a trailing "_" goes): folders are matched to
  // threads through it.
  const threadsByFolder = new Map<string, string[]>();
  for (const { id } of input.db.prepare("select id from agent_threads").all() as Array<{ id: string }>) {
    const name = segment(id);
    threadsByFolder.set(name, [...(threadsByFolder.get(name) ?? []), id]);
  }
  // Its newest message by the (thread_id, seq) index, as AgentStore's
  // lastActivityAt reads it (an idle compaction's summary is not activity);
  // a thread with none, its row's.
  const activityOf = input.db.prepare(
    `select coalesce(
       (select created_at from agent_messages where thread_id = ?1 and ${NOT_IDLE_SUMMARY} order by seq desc limit 1),
       (select updated_at from agent_threads where id = ?1)
     ) as at`
  );
  /** The latest activity of the threads a folder may be: null when none is. */
  const lastActivity = (folder: string): number | null => {
    let latest: number | null = null;
    for (const id of threadsByFolder.get(folder) ?? []) {
      const at = (activityOf.get(id) as { at: string | null } | null)?.at;
      if (at) latest = Math.max(latest ?? 0, Date.parse(at));
    }
    return latest;
  };
  let deleted = 0;
  for (const owner of owners(dataDir)) {
    const root = resourceDir(owner, "tool-output", dataDir);
    let folders: fs.Dirent[];
    try {
      folders = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const folder of folders) {
      const dir = path.join(root, folder.name);
      const at = lastActivity(folder.name);
      // No thread (deleted, or never one): nothing will read its files.
      const quiet = at === null || at < quietBefore;
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(dir, file.name);
        if (running.has(path.resolve(filePath))) continue;
        try {
          if (!quiet && fs.statSync(filePath).mtimeMs >= oldBefore) continue;
          fs.unlinkSync(filePath);
          deleted++;
        } catch (err) {
          logError("tool-output retention", err, `could not delete ${filePath}`);
        }
      }
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // Written to meanwhile, or gone: the next pass sees it.
      }
    }
  }
  return { deleted };
}
