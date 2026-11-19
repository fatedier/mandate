import path from "node:path";
import { Database } from "bun:sqlite";
import {
  LlmCallStore,
  type FinishLlmCallInput,
  type LlmCallFilters,
  type StartLlmCallInput
} from "../modules/activity/llm-call-store.js";
import { WorkerWindowStore } from "../modules/workers/worker-window-store.js";
import { getMandateModules } from "../modules/registry.js";
import { initializeDatabaseSchema } from "../platform/db/schema.js";
import { stallWatch, watchDatabase } from "../platform/diagnostics/stall-watch.js";

export class MandateStore {
  db: Database;
  private readonly workerWindows: WorkerWindowStore;
  private readonly llmCalls: LlmCallStore;

  constructor(rootDir: string) {
    // Every statement timed: a slow one is named when the server stalls.
    this.db = watchDatabase(new Database(path.join(rootDir, "mandate.db")), stallWatch);
    // busy_timeout first, and not for tidiness: switching journal mode takes a
    // brief exclusive lock, so with the timeout still at its default 0 a second
    // connection opening the same fresh database fails outright instead of
    // waiting. Measured on a held lock: 1ms to "database is locked" in this
    // order reversed, against a full wait once the timeout is in force.
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec("pragma journal_mode = wal");
    // 64 MB of pages, not SQLite's 8 MB: on a large database one long thread
    // read can push every other table's pages out, and the next reads then
    // wait on the disk while the server can do nothing else.
    this.db.exec("pragma cache_size = -65536");
    const modules = getMandateModules();
    initializeDatabaseSchema(this.db, modules);
    this.workerWindows = new WorkerWindowStore(this.db);
    this.llmCalls = new LlmCallStore(this.db);
    this.llmCalls.markInterruptedLiveCallsFailed();
  }

  listWorkerWindowKeys(): Set<string> {
    return this.workerWindows.listActiveWindowKeys();
  }

  startLlmCall(input: StartLlmCallInput) {
    return this.llmCalls.startLlmCall(input);
  }

  finishLlmCall(id: string, input: FinishLlmCallInput) {
    return this.llmCalls.finishLlmCall(id, input);
  }

  mergeLlmCallMetadata(id: string, patch: unknown) {
    return this.llmCalls.mergeLlmCallMetadata(id, patch);
  }

  listLlmCallSummaries(limit = 20, options: LlmCallFilters = {}) {
    return this.llmCalls.listLlmCallSummaries(limit, options);
  }

  matchingLlmCallIds(options: LlmCallFilters = {}) {
    return this.llmCalls.matchingLlmCallIds(options);
  }

  getLlmCall(id: string) {
    return this.llmCalls.getLlmCall(id);
  }
}
