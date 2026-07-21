import path from "node:path";
import { Database } from "bun:sqlite";
import {
  LlmCallStore,
  type FinishLlmCallInput,
  type LlmCallFilters,
  type StartLlmCallInput
} from "../modules/activity/llm-call-store.js";
import { FeatureWindowStore } from "../modules/features/feature-window-store.js";
import { collectModuleMigrations, initializeDatabaseSchema } from "../platform/db/schema.js";
import { runPendingMigrations } from "../platform/db/migrations.js";

export type { FinishLlmCallInput, LlmCallFilters, StartLlmCallInput };

export class MandateStore {
  db: Database;
  private readonly featureWindows: FeatureWindowStore;
  private readonly llmCalls: LlmCallStore;

  constructor(rootDir: string) {
    this.db = new Database(path.join(rootDir, "mandate.db"));
    // busy_timeout first, and not for tidiness: switching journal mode takes a
    // brief exclusive lock, so with the timeout still at its default 0 a second
    // connection opening the same fresh database fails outright instead of
    // waiting. Measured on a held lock: 1ms to "database is locked" in this
    // order reversed, against a full wait once the timeout is in force.
    this.db.exec("pragma busy_timeout = 5000");
    this.db.exec("pragma journal_mode = wal");
    initializeDatabaseSchema(this.db);
    // Convergent DDL first so the schema is complete, then the one-shot
    // migrations that need it to be. Do not wrap this constructor in a
    // transaction: the runner creates schema_migrations inside whatever
    // transaction the caller holds, so a rollback would drop that table and a
    // failing migration would abort the caller's whole transaction.
    runPendingMigrations(this.db, collectModuleMigrations());
    this.featureWindows = new FeatureWindowStore(this.db);
    this.llmCalls = new LlmCallStore(this.db);
    this.llmCalls.markInterruptedLiveCallsFailed();
  }

  listFeatureWindowKeys(): Set<string> {
    return this.featureWindows.listActiveWindowKeys();
  }

  startLlmCall(input: StartLlmCallInput) {
    return this.llmCalls.startLlmCall(input);
  }

  finishLlmCall(id: string, input: FinishLlmCallInput) {
    return this.llmCalls.finishLlmCall(id, input);
  }

  listLlmCalls(limit = 50, options: LlmCallFilters = {}) {
    return this.llmCalls.listLlmCalls(limit, options);
  }

  listLlmCallSummaries(limit = 20, options: LlmCallFilters = {}) {
    return this.llmCalls.listLlmCallSummaries(limit, options);
  }

  getLlmCall(id: string) {
    return this.llmCalls.getLlmCall(id);
  }
}
