import type { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";
import type { MemoryDreamTriggerResult } from "../../../shared/api-contracts.js";
import type { MemoryDreamer, MemoryDreamRunResult } from "./dream.js";
import type { MemoryDreamTicker } from "./dream-runs.js";
import type { MemoryDreamPartition } from "./dream-rules.js";

/** Databases with a dream running. Per database, not per job: the container
 *  builds a new job when the config reloads, while the old one may still run. */
const dreamingDatabases = new WeakSet<Database>();

/** Per database, when a tick first saw each partition need a run: its change
 *  waits for a quiet moment from then. Per database for the same reason, so a
 *  rebuilt job keeps it; a run, or a restart, starts it over. */
const waitingSince = new WeakMap<Database, Map<string, number>>();

export class MemoryDreamJob implements MemoryDreamTicker {
  private readonly startedAtMs: number;

  constructor(private input: {
    db: Database;
    dreamer: Pick<MemoryDreamer, "run" | "needsRun" | "unusedSinceBrief">;
    activeProjectIds: () => string[];
    idleMs?: number;
    partitionIntervalMs?: number;
    /** How long a project no worker has used since its brief keeps its changes waiting. */
    unusedProjectMaxWaitMs?: number;
    /** How long a change waits for the user to go quiet before it is curated anyway. */
    maxWaitMs?: number;
    now?: () => number;
  }) {
    this.startedAtMs = input.now?.() ?? Date.now();
  }

  async tick(trigger = "idle", options: { force?: boolean } = {}): Promise<MemoryDreamTriggerResult> {
    if (dreamingDatabases.has(this.input.db)) return { skipped: true, reason: "already_running" };
    const now = this.input.now?.() ?? Date.now();
    const interval = this.input.partitionIntervalMs ?? 6 * 60 * 60 * 1000;
    const unusedMaxWait = this.input.unusedProjectMaxWaitMs ?? 7 * 24 * 60 * 60 * 1000;
    const waiting = waitingSince.get(this.input.db) ?? new Map<string, number>();
    waitingSince.set(this.input.db, waiting);
    let due = this.partitions().flatMap((partition) => {
      const key = partition.kind === "user" ? "user" : `project:${partition.projectId}`;
      // Not only a run ends a need: a partition with no brief can lose its
      // only memory. What it needs later waits afresh.
      if (!this.input.dreamer.needsRun(partition)) {
        waiting.delete(key);
        return [];
      }
      // A project's brief is read only where its workers are: while none has
      // worked there since it was built, its changes wait for one, a week at
      // most. Its wait for a quiet moment starts once it is used.
      const unusedSince = options.force ? null : this.input.dreamer.unusedSinceBrief(partition);
      if (unusedSince !== null && now - unusedSince < unusedMaxWait) return [];
      if (!waiting.has(key)) waiting.set(key, now);
      return options.force || now - (latestPartitionRunMs(this.input.db, partition) ?? 0) >= interval ? [{ partition, key }] : [];
    });
    if (due.length === 0) return { skipped: true, reason: "nothing_due" };
    // A quiet moment is preferred: it gathers a stretch of work into one run.
    // While the user keeps talking, only what has waited long enough runs.
    const idleSince = Math.max(latestHumanInputMs(this.input.db) ?? 0, this.startedAtMs);
    const quiet = options.force || now - idleSince >= (this.input.idleMs ?? 30 * 60 * 1000);
    if (!quiet) {
      const maxWait = this.input.maxWaitMs ?? 6 * 60 * 60 * 1000;
      due = due.filter(({ key }) => now - waiting.get(key)! >= maxWait);
      if (due.length === 0) return { skipped: true, reason: "not_idle_long_enough" };
    }
    const runTrigger = quiet ? trigger : "overdue";
    dreamingDatabases.add(this.input.db);
    try {
      const results: MemoryDreamRunResult[] = [];
      let failures = 0;
      for (const { partition, key } of due) {
        // A change made while this run goes waits from the tick that sees it.
        waiting.delete(key);
        try {
          const result = await this.input.dreamer.run(runTrigger, partition);
          // An emptied partition only loses its brief: no run was recorded.
          if (result.processed) results.push(result);
        } catch (error) {
          // The run recorded its failure; the next partition still gets its turn.
          failures += 1;
          console.warn(`[mandate] memory dream ${partition.kind} failed: ${errorText(error)}`);
        }
      }
      if (results.length === 0) return { skipped: true, reason: failures > 0 ? "every_partition_failed" : "nothing_due" };
      return aggregateResults(results, runTrigger);
    } finally {
      dreamingDatabases.delete(this.input.db);
    }
  }

  private partitions(): MemoryDreamPartition[] {
    return [{ kind: "user" }, ...this.input.activeProjectIds().map((projectId) => ({ kind: "project" as const, projectId }))];
  }
}

function latestHumanInputMs(db: Database) {
  const row = db.prepare(`
    select max(created_at) as ts
    from agent_messages
    where role = 'user'
      and source in ('user', 'voice')
  `).get() as { ts: string | null } | undefined;
  return row?.ts ? Date.parse(row.ts) : null;
}

function latestPartitionRunMs(db: Database, partition: MemoryDreamPartition): number | null {
  const row = db.prepare(`
    select max(coalesce(finished_at, started_at)) as at from memory_dream_runs
    where phase = ? and coalesce(project_id, '') = ?
  `).get(partition.kind, partition.kind === "project" ? partition.projectId : "") as { at: string | null };
  return row.at ? Date.parse(row.at) : null;
}

function aggregateResults(results: MemoryDreamRunResult[], trigger: string): MemoryDreamTriggerResult {
  const last = results.at(-1)!;
  const sum = (key: "candidateCount" | "actionCount" | "appliedCount" | "rejectedCount" | "failedCount") =>
    results.reduce((total, result) => total + result[key], 0);
  return {
    runId: last.runId, trigger, phase: last.phase, projectId: last.projectId, processed: results.some((r) => r.processed),
    candidateCount: sum("candidateCount"), actionCount: sum("actionCount"), appliedCount: sum("appliedCount"),
    rejectedCount: sum("rejectedCount"), failedCount: sum("failedCount"),
    runCount: results.length, runIds: results.map((r) => r.runId),
    partitions: results.map(({ runId, trigger: t, phase, projectId, processed, candidateCount, actionCount, appliedCount, rejectedCount, failedCount }) =>
      ({ runId, trigger: t, phase, projectId, processed, candidateCount, actionCount, appliedCount, rejectedCount, failedCount }))
  };
}
