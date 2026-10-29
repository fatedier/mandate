import type { Database } from "bun:sqlite";
import type { Config } from "../config.js";
import type { MemoryDreamTicker } from "../modules/memory/dream-runs.js";
import { runRetentionPass } from "../platform/db/retention.js";
import { sweepToolOutputs } from "../platform/db/tool-output-retention.js";
import { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import { runHistoryWordsFill } from "../modules/agent/history-words.js";
import { FeatureRecordStore } from "../modules/plans/record-store.js";
import { logError } from "../platform/logger.js";
import type { TmuxPoller } from "../runtime/tmux-poller.js";

const MEMORY_DREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** Price data: first refresh a while after start, then daily. */
const PRICE_REFRESH_FIRST_MS = 10 * 60 * 1000;
const PRICE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRICING_PASS_INTERVAL_MS = 5_000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 500;
const POLL_JITTER_RATIO = 0.12;
const POLL_JITTER_MAX_MS = 1000;

export function createBackgroundJobsStarter(input: {
  config: Config;
  poller: TmuxPoller;
  onInitialPollComplete?: () => void;
  memoryDreamJob?: MemoryDreamTicker | null | (() => MemoryDreamTicker | null);
  db?: Database | null;
  /** Refreshes the price data (skipped inside when the user turned it off). */
  priceData?: { refresh(): Promise<unknown> } | null;
  /** Prices calls in bounded steps; a tick is cheap when nothing is waiting. */
  pricingPass?: { tick(): void } | null;
}) {
  const { config, poller, memoryDreamJob, db } = input;
  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  const pollIntervalMs = () => Math.max(MIN_POLL_INTERVAL_MS, Math.floor(Number(config.pollIntervalMs) || 0));
  const clearPollTimer = () => {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = null;
  };
  const schedulePoll = () => {
    clearPollTimer();
    // A poll still in flight when stop() ran lands here through its finally.
    if (stopped) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poller.poll().finally(schedulePoll);
    }, jitteredPollDelayMs(pollIntervalMs()));
  };

  return {
    start() {
      if (started || stopped) return;
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
        intervals.push(setInterval(tickDream, MEMORY_DREAM_CHECK_INTERVAL_MS));
        tickDream();
      }

      const pricingPass = input.pricingPass;
      if (pricingPass) intervals.push(setInterval(() => pricingPass.tick(), PRICING_PASS_INTERVAL_MS));

      const priceData = input.priceData;
      if (priceData) {
        const refreshPrices = () => {
          void priceData.refresh().catch((e) => logError("price-data", e, "price data refresh failed"));
        };
        timeouts.push(setTimeout(() => {
          refreshPrices();
          intervals.push(setInterval(refreshPrices, PRICE_REFRESH_INTERVAL_MS));
        }, PRICE_REFRESH_FIRST_MS));
      }

      if (db) {
        // The chat history words index: filled after start-up, a batch at a
        // time, when it is not ready or the entries changed under it (an
        // older binary ran in between). Scheduled, so start() reads nothing.
        timeouts.push(setTimeout(() => {
          try {
            runHistoryWordsFill(db, {
              schedule: (step, delayMs = 0) => { timeouts.push(setTimeout(step, delayMs)); },
              log: (line) => console.log(line),
              onError: (e) => logError("history-words", e, "filling the words index failed")
            });
          } catch (e) {
            logError("history-words", e, "checking the words index failed");
          }
        }, 0));
        // Workers' task records, read again by word (record-store.ts reindex).
        timeouts.push(setTimeout(() => {
          try {
            const { read, icuChanged } = new FeatureRecordStore(db).reindex();
            if (icuChanged) console.log(`[mandate] task records: read ${read} records into their words index`);
          } catch (e) {
            logError("feature-records", e, "re-reading the task records' words failed");
          }
        }, 0));
        // Deliberately not called once up front the way tickDream is, and the
        // measurement argues that more strongly than the estimate it replaces. A
        // pass with a backlog to work through is the cheap one, because the per-tick
        // cap breaks it off early; a pass with nothing left to do costs a few hundred ms,
        // nearly all of it spent proving there is nothing to do. So it is the idle
        // pass that is expensive, and once the backlog drains on day one every
        // startup is the idle case -- calling it here would pay the worse number, on
        // every restart, forever. (Not the figure an earlier estimate gave: that
        // extrapolated a working pass from a per-row delete cost.) The backlog is
        // dead data -- a first pass an hour from now is soon enough.
        intervals.push(setInterval(() => {
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
          // Tool output files: a quiet week, a month at most; a running
          // command's file stays.
          try {
            const { deleted } = sweepToolOutputs({ db, now: new Date(), runningPaths: new BackgroundTaskStore(db).runningOutputPaths() });
            if (deleted > 0) console.log(`[mandate] retention: deleted ${deleted} tool output files`);
          } catch (e) {
            logError("retention-job", e, "tool output retention failed");
          }
        }, RETENTION_INTERVAL_MS));
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

    /** Clears every timer start() registered. Final: a stopped starter does
     *  not start again. */
    stop() {
      stopped = true;
      clearPollTimer();
      for (const handle of intervals.splice(0)) clearInterval(handle);
      for (const handle of timeouts.splice(0)) clearTimeout(handle);
    },

    refreshPollInterval() {
      if (!started || stopped) return;
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
