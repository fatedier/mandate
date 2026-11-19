import type { Database } from "bun:sqlite";
import type { Config } from "../config.js";
import type { MemoryDreamTicker } from "../modules/memory/dream-runs.js";
import { applyRetentionWork, type CeilingReading } from "../platform/db/retention.js";
import { removeToolOutputs } from "../platform/db/tool-output-retention.js";
import { sweepSideChatArchives } from "../platform/fs/side-chat-archive-retention.js";
import { sideChatArchiveDir } from "../platform/fs/resources.js";
import { runRetentionAway, type RetentionOutcome, type RetentionRequest } from "../platform/db/retention-away.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import { mergeHistoryWords, runHistoryWordsFill } from "../modules/agent/history-words.js";
import { advanceHistoryBackfillMark } from "../modules/agent/history-store.js";
import { WorkerRecordStore } from "../modules/plans/record-store.js";
import { logError } from "../platform/logger.js";
import type { TmuxPoller } from "../runtime/tmux-poller.js";
import { stallWatch } from "../platform/diagnostics/stall-watch.js";

const MIN_POLL_INTERVAL_MS = 500;
const POLL_JITTER_RATIO = 0.12;
const POLL_JITTER_MAX_MS = 1000;
/** How often queued skill reviews are looked for, besides each request's own start. */
const SKILL_REVIEW_CHECK_EVERY_MS = 60_000;
/** How often the user's direct chats are checked for one gone quiet. */
const DIRECT_CHATS_CHECK_EVERY_MS = 60_000;

export function createBackgroundJobsStarter(input: {
  config: Config;
  poller: TmuxPoller;
  onInitialPollComplete?: () => void;
  memoryDreamJob?: MemoryDreamTicker | null | (() => MemoryDreamTicker | null);
  /** Requested skill reviews: each request starts one at once; this tick
   *  starts those a restart left queued. */
  skillReviewJob?: { tick(): Promise<void> } | null;
  /** The 60-day rule on learned skills: checked with the skill reviews,
   *  it does its work once a day (createUnusedSkillsRule). */
  unusedSkillsRule?: { tick(): Promise<void> } | null;
  /** The user's direct chats with manager threads, told once they go quiet. */
  directChats?: { tick(): Promise<void> } | null;
  db?: Database | null;
  /** Refreshes the price data (skipped inside when the user turned it off). */
  priceData?: { refresh(): Promise<unknown> } | null;
  /** Prices calls in bounded steps; a tick is cheap when nothing is waiting. */
  pricingPass?: { tick(): void } | null;
  /** Works the Activity slices out ahead when hours are missing or their
   *  prices changed (ActivityFill); a check that finds nothing reads no call. */
  activityFill?: { check(): void } | null;
  /** One retention pass off the main thread (runRetentionAway; tests pass their own). */
  runRetention?: (request: RetentionRequest) => { done: Promise<RetentionOutcome>; stop(): void };
  /** The database's checkpoints, run off the main thread while the jobs run
   *  (startBackgroundCheckpoints). Absent: SQLite's own, on the connection. */
  checkpoints?: (db: Database) => { stop(): void };
  /** Loads the memory vectors ahead of the first search (warmAgentMemoryVectors). */
  memoryVectors?: { warm(): Promise<void> } | null;
}) {
  const { config, poller, memoryDreamJob, db } = input;
  const runRetention = input.runRetention ?? runRetentionAway;
  /** The pass at work, if one is. */
  let retentionRun: { stop(): void } | null = null;
  let checkpointRun: { stop(): void } | null = null;
  /** The last measure of the chat table, carried from pass to pass. */
  let ceiling: CeilingReading | null = null;
  let started = false;
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  const pollIntervalMs = () => config.pollIntervalMs;
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
      void stallWatch.watched("tmux poll", () => poller.poll()).finally(schedulePoll);
    }, jitteredPollDelayMs(pollIntervalMs()));
  };

  return {
    start() {
      // The jobs' pacing: config.json's runtime section, today's unless it says otherwise.
      const pace = config.runtime;
      if (started || stopped) return;
      started = true;

      // First: every write after it is checkpointed off the main thread.
      if (db && input.checkpoints) {
        try {
          checkpointRun = input.checkpoints(db);
        } catch (e) {
          logError("checkpoints", e, "background checkpoints did not start; SQLite checkpoints on the server's connection");
        }
      }

      void poller.poll().finally(input.onInitialPollComplete);
      schedulePoll();

      if (memoryDreamJob) {
        const tickDream = () => {
          const job = typeof memoryDreamJob === "function" ? memoryDreamJob() : memoryDreamJob;
          if (!job) return;
          void stallWatch.watched("memory dream tick", () => job.tick("idle")).catch((e) => {
            logError("memory-dream-job", e, "memory dream job failed");
          });
        };
        intervals.push(setInterval(tickDream, pace.dreamCheckEveryMs));
        tickDream();
      }

      const skillReviewJob = input.skillReviewJob;
      if (skillReviewJob) {
        const tickReview = () => {
          void stallWatch.watched("skill review tick", () => skillReviewJob.tick()).catch((e) => {
            logError("skill-review-job", e, "skill review job failed");
          });
        };
        intervals.push(setInterval(tickReview, SKILL_REVIEW_CHECK_EVERY_MS));
        tickReview();
      }

      const unusedSkillsRule = input.unusedSkillsRule;
      if (unusedSkillsRule) {
        const tickRule = () => {
          void stallWatch.watched("unused skills rule", () => unusedSkillsRule.tick()).catch((e) => {
            logError("unused-skills-rule", e, "the 60-day rule on learned skills failed");
          });
        };
        intervals.push(setInterval(tickRule, SKILL_REVIEW_CHECK_EVERY_MS));
        tickRule();
      }

      const directChats = input.directChats;
      if (directChats) {
        const tickChats = () => {
          void stallWatch.watched("direct chats", () => directChats.tick()).catch((e) => {
            logError("direct-chats", e, "telling the user's direct chats failed");
          });
        };
        intervals.push(setInterval(tickChats, DIRECT_CHATS_CHECK_EVERY_MS));
        tickChats();
      }

      const pricingPass = input.pricingPass;
      if (pricingPass) intervals.push(setInterval(() => stallWatch.watched("pricing pass", () => pricingPass.tick()), pace.pricingPassEveryMs));

      const activityFill = input.activityFill;
      if (activityFill) intervals.push(setInterval(() => stallWatch.watched("activity slices check", () => activityFill.check()), pace.activitySlicesCheckEveryMs));

      const memoryVectors = input.memoryVectors;
      if (memoryVectors) {
        timeouts.push(setTimeout(() => {
          void memoryVectors.warm().catch((e) => logError("memory-vectors", e, "loading the memory vectors ahead failed; the first search loads them"));
        }, pace.memoryVectorsWarmMs));
      }

      const priceData = input.priceData;
      if (priceData) {
        const refreshPrices = () => {
          void priceData.refresh().catch((e) => logError("price-data", e, "price data refresh failed"));
        };
        timeouts.push(setTimeout(() => {
          refreshPrices();
          intervals.push(setInterval(refreshPrices, pace.priceDataEveryMs));
        }, pace.priceDataFirstMs));
      }

      if (db) {
        // The chat history words index: filled after start-up, a batch at a
        // time, when it is not whole for this segmenter. Scheduled, so
        // start() reads nothing.
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
        // The words index merges in these steps, not inside a message's write.
        intervals.push(setInterval(() => {
          try {
            stallWatch.run("history words merge", () => mergeHistoryWords(db));
          } catch (e) {
            logError("history-words", e, "merging the words index failed");
          }
        }, pace.historyWordsMergeEveryMs));
        // Workers' task records, read again by word (record-store.ts reindex).
        timeouts.push(setTimeout(() => {
          try {
            const { read, icuChanged } = new WorkerRecordStore(db).reindex();
            if (icuChanged) console.log(`[mandate] task records: read ${read} records into their words index`);
          } catch (e) {
            logError("worker-records", e, "re-reading the task records' words failed");
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
          // One at a time: a pass still at work (a slow disk, a backlog) is
          // left to finish rather than raced by the next.
          if (retentionRun) return;
          const run = runRetention({
            dbPath: db.filename,
            nowMs: Date.now(),
            retention: config.retention,
            ceiling,
            dataDir: resolveDataDir(),
            // Tool output files: a quiet week, a month at most; a running
            // command's file stays.
            runningPaths: new BackgroundTaskStore(db).runningOutputPaths()
          });
          retentionRun = run;
          void run.done.then((outcome) => {
            ceiling = outcome.ceiling;
            const { work, toolOutputs } = outcome;
            // Done here, by the server's own connection: a few hundred rows
            // and files, each asked again as it is written or removed.
            if ("error" in work) logError("retention-job", new Error(work.error), "retention pass failed");
            else {
              try {
                const pass = stallWatch.run("retention pass", () => applyRetentionWork(db, work, new Date()));
                // Every message since is indexed: the next backfill (a restart's
                // first search) looks only past here, and the skip markers below
                // go in the next pass.
                stallWatch.run("history backfill mark", () => advanceHistoryBackfillMark(db));
                if (Object.values(pass).some((n) => n > 0)) {
                  // Freed pages are reused by later writes rather than returned to the
                  // filesystem: the file does not shrink, it stops growing as fast.
                  console.log(
                    `[mandate] retention: removed ${pass.runtimeContextDeleted} superseded runtime-context rows, `
                    + `cleared ${pass.llmPayloadsCleared} old llm payloads, `
                    + `truncated ${pass.toolResultsTruncated} tool results, `
                    + `dropped the replay copies of ${pass.replayStateCleared} compacted replies, `
                    + `deleted ${pass.mailboxDeleted} delivered mail `
                    + `and ${pass.skipMarkersDeleted} search skip markers`
                  );
                }
              } catch (e) {
                logError("retention-job", e, "retention pass failed");
              }
            }
            if ("error" in toolOutputs) logError("retention-job", new Error(toolOutputs.error), "tool output retention failed");
            else {
              try {
                const { deleted } = stallWatch.run("tool output retention", () => removeToolOutputs(
                  { db, dataDir: resolveDataDir(), now: new Date(), runningPaths: new BackgroundTaskStore(db).runningOutputPaths() },
                  toolOutputs
                ));
                if (deleted > 0) console.log(`[mandate] retention: deleted ${deleted} tool output files`);
              } catch (e) {
                logError("retention-job", e, "tool output retention failed");
              }
            }
            // The side chats sent to the personal agent, 30 days after each was sent.
            try {
              const { deleted } = stallWatch.run("side chat retention", () => sweepSideChatArchives({ dir: sideChatArchiveDir(resolveDataDir()), now: new Date() }));
              if (deleted > 0) console.log(`[mandate] retention: deleted ${deleted} side chat files`);
            } catch (e) {
              logError("retention-job", e, "side chat retention failed");
            }
          }, (e: unknown) => {
            // Ended by stop(): nothing failed.
            if (!stopped) logError("retention-job", e, "retention pass failed");
          }).finally(() => {
            if (retentionRun === run) retentionRun = null;
          });
        }, pace.retentionEveryMs));
        // Until a pass actually frees something there is no other sign this job
        // exists: the first pass is an interval away, a pass that finds nothing stays
        // quiet, and the file never shrinks either way. Without this line "scheduled
        // and idle" and "never shipped" read identically in the logs.
        console.log(
          `[mandate] retention: scheduled every ${Math.round(pace.retentionEveryMs / 60_000)}m, `
          + `first pass one interval from now rather than at startup`
        );
      }
    },

    /** Clears every timer start() registered. Final: a stopped starter does
     *  not start again. */
    stop() {
      stopped = true;
      clearPollTimer();
      retentionRun?.stop();
      retentionRun = null;
      checkpointRun?.stop();
      checkpointRun = null;
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
