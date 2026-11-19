/**
 * Works out one Activity summary, the slices kept for the next ones, the
 * log's filter lists, its Cache expired
 * calls or a view's count off the server's main thread (see
 * summarizeActivityAway): reading and
 * weighing a month of stored calls, or every call for its models, takes long
 * enough that on the main thread it would hold up every agent, terminal and
 * request. A built entrypoint of its own (scripts/build-binary.ts).
 */
import { Database } from "bun:sqlite";
import { errorText } from "../../../shared/error-text.js";
import { createPriceCatalog } from "../pricing/catalog.js";
import { answerSummary, fillActivitySlices } from "./activity-rollup.js";
import { dailyUsage, expiredVerdicts, type AwayJob } from "./activity-summary-away.js";
import { LlmCallStore } from "./llm-call-store.js";
import { listActivityFilterOptions } from "./filter-options.js";

declare const self: {
  onmessage: ((event: MessageEvent<AwayJob>) => void) | null;
  postMessage(message: unknown): void;
};

self.onmessage = (event) => {
  const job = event.data;
  try {
    // Read-only: this thread never writes, whatever a reader below would try.
    const db = new Database(job.dbPath, { readonly: true });
    try {
      if (job.job === "filter-options") {
        self.postMessage({ ok: true, result: listActivityFilterOptions(db) });
        return;
      }
      if (job.job === "daily-usage") {
        self.postMessage({ ok: true, result: dailyUsage(db, job.days) });
        return;
      }
      if (job.job === "expired-verdicts") {
        self.postMessage({ ok: true, result: expiredVerdicts(db, job.since) });
        return;
      }
      if (job.job === "count-calls") {
        self.postMessage({ ok: true, result: new LlmCallStore(db).countLlmCalls(job.filters) });
        return;
      }
      if (job.job === "fill") {
        const deps = { catalog: job.prices ? createPriceCatalog(job.prices) : null, providers: job.providers };
        // A plain BEGIN, deferred: slices, changes and calls are the first read's snapshot.
        self.postMessage({ ok: true, result: db.transaction(() => fillActivitySlices(db, { now: job.now, checked: job.checked }, deps, job.inputs))() });
        return;
      }
      const { dbPath: _dbPath, providers, prices, inputs, job: _job, ...input } = job;
      const catalog = prices ? createPriceCatalog(prices) : null;
      self.postMessage({ ok: true, result: answerSummary(db, input, { catalog, providers }, inputs) });
    } finally {
      db.close();
    }
  } catch (error) {
    self.postMessage({ ok: false, message: errorText(error) });
  }
};
