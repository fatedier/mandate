import type { Database } from "bun:sqlite";
import type { Config } from "../config.js";
import type { MemoryDreamJob } from "../modules/memory/dream.js";
import { runRetentionPass } from "../platform/db/retention.js";
import { logError } from "../platform/logger.js";
import type { TmuxPoller } from "../runtime/tmux-poller.js";

const MEMORY_DREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 500;
const POLL_JITTER_RATIO = 0.12;
const POLL_JITTER_MAX_MS = 1000;

export function createBackgroundJobsStarter(input: {
  config: Config;
  poller: TmuxPoller;
  onInitialPollComplete?: () => void;
  memoryDreamJob?: MemoryDreamJob | null | (() => MemoryDreamJob | null);
  db?: Database | null;
}) {
  const { config, poller, memoryDreamJob, db } = input;
  let started = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  const pollIntervalMs = () => Math.max(MIN_POLL_INTERVAL_MS, Math.floor(Number(config.pollIntervalMs) || 0));
  const clearPollTimer = () => {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = null;
  };
  const schedulePoll = () => {
    clearPollTimer();
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poller.poll().finally(schedulePoll);
    }, jitteredPollDelayMs(pollIntervalMs()));
  };

  return {
    start() {
      if (started) return;
      started = true;

      void poller.poll().finally(input.onInitialPollComplete);
      schedulePoll();

      if (memoryDreamJob) {
        const tickDream = () => {
          const job = typeof memoryDreamJob === "function" ? memoryDreamJob() : memoryDreamJob;
          if (!job) return;
          void job.tick("idle").catch((e) => {
            logError("memory-dream-job", e, "memory dream job failed");
          });
        };
        setInterval(tickDream, MEMORY_DREAM_CHECK_INTERVAL_MS);
        tickDream();
      }

      if (db) {
        // Deliberately not called once up front the way tickDream is, and the
        // measurement argues that more strongly than the estimate it replaces. A
        // pass with a backlog to work through costs 38-110 ms, because the per-tick
        // cap breaks it off early; a pass with nothing left to do costs 200-280 ms,
        // nearly all of it spent proving there is nothing to do. So it is the idle
        // pass that is expensive, and once the backlog drains on day one every
        // startup is the idle case -- calling it here would pay the worse number, on
        // every restart, forever. (Not the 165 ms an earlier note gave: that
        // extrapolated a working pass from a per-row delete cost.) The backlog is
        // dead data -- a first pass an hour from now is soon enough.
        setInterval(() => {
          try {
            const result = runRetentionPass(db, new Date(), config.retention);
            if (
              result.runtimeContextDeleted > 0
              || result.llmPayloadsCleared > 0
              || result.toolResultsTruncated > 0
            ) {
              // Freed pages are reused by later writes rather than returned to the
              // filesystem: the file does not shrink, it stops growing as fast.
              console.log(
                `[mandate] retention: removed ${result.runtimeContextDeleted} superseded runtime-context rows, `
                + `cleared ${result.llmPayloadsCleared} old llm payloads, `
                + `truncated ${result.toolResultsTruncated} tool results`
              );
            }
          } catch (e) {
            logError("retention-job", e, "retention pass failed");
          }
        }, RETENTION_INTERVAL_MS);
        // Until a pass actually frees something there is no other sign this job
        // exists: the first pass is an interval away, a pass that finds nothing stays
        // quiet, and the file never shrinks either way. Without this line "scheduled
        // and idle" and "never shipped" read identically in the logs.
        console.log(
          `[mandate] retention: scheduled every ${Math.round(RETENTION_INTERVAL_MS / 60_000)}m, `
          + `first pass one interval from now rather than at startup`
        );
      }
    },

    refreshPollInterval() {
      if (!started) return;
      schedulePoll();
      void poller.poll();
    }
  };
}

export function jitteredPollDelayMs(baseMs: number, random = Math.random): number {
  const base = Math.max(MIN_POLL_INTERVAL_MS, Math.floor(Number(baseMs) || 0));
  const spread = Math.min(POLL_JITTER_MAX_MS, Math.floor(base * POLL_JITTER_RATIO));
  if (spread <= 0) return base;
  const offset = Math.floor((random() * 2 - 1) * spread);
  return Math.max(MIN_POLL_INTERVAL_MS, base + offset);
}
