import * as path from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MandateStore } from "../src/server/app/store.js";
import { initializeDatabaseSchema } from "../src/server/platform/db/schema.js";
import { getMandateModules } from "../src/server/modules/registry.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";

const tempStore = () => freshStoresEnv("md-db-");

test("MandateStore records low-level LLM calls", () => {
  const { store, cleanup } = tempStore();
  try {
    const started = store.startLlmCall({
      purpose: "agent_wake_step",
      scopeType: "agent_thread",
      scopeId: "thr-test",
      provider: "openai-compatible",
      model: "deepseek-v4-flash",
      baseURL: "https://example.test/v1",
      apiMode: "generateText",
      requestJson: {
        messages: [{ role: "user", content: "wake this thread" }]
      },
      metadataJson: {
        threadId: "thr-test",
        phase: "initial"
      }
    });

    store.finishLlmCall(started.id, {
      status: "succeeded",
      responseJson: { finishReason: "stop" },
      outputJson: { status: "done" },
      usageJson: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      latencyMs: 321
    });

    const calls = store.listLlmCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].purpose).toBe("agent_wake_step");
    expect(calls[0].scopeType).toBe("agent_thread");
    expect(calls[0].scopeId).toBe("thr-test");
    expect(calls[0].provider).toBe("openai-compatible");
    expect(calls[0].model).toBe("deepseek-v4-flash");
    expect(calls[0].status).toBe("succeeded");
    expect(calls[0].inputTokens).toBe(10);
    expect(calls[0].outputTokens).toBe(4);
    expect(calls[0].totalTokens).toBe(14);
    expect(calls[0].latencyMs).toBe(321);
    expect((calls[0].request as { messages: { content: string }[] }).messages[0].content).toBe("wake this thread");
    expect((calls[0].output as { status: string }).status).toBe("done");
    expect(calls[0].metadata!.threadId).toBe("thr-test");
    expect(calls[0].requestHash).toBeTruthy();

    const summaries = store.listLlmCallSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].request).toBe(null);
    expect(summaries[0].response).toBe(null);
    expect(summaries[0].output).toBe(null);
    expect(summaries[0].usage).toBe(null);
    expect(summaries[0].metadata!.threadId).toBe("thr-test");
    expect(summaries[0].requestHash).toBe(calls[0].requestHash);

    const detail = store.getLlmCall(started.id);
    expect((detail?.request as { messages: { content: string }[] }).messages[0].content).toBe("wake this thread");

  } finally {
    cleanup();
  }
});

test("MandateStore marks interrupted live LLM calls failed on startup", () => {
  const dir = tempDir("md-db-interrupted-");
  let restarted: MandateStore | null = null;
  try {
    const db = new Database(path.join(dir, "mandate.db"));
    initializeDatabaseSchema(db, getMandateModules());
    db.prepare(
      `
      insert into llm_calls (id, purpose, status, started_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `
    ).run(
      "llm-interrupted",
      "agent_wake_step",
      "running",
      "2026-05-20T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z"
    );
    db.close();

    restarted = new MandateStore(dir);
    const call = restarted.getLlmCall("llm-interrupted");
    expect(call?.status).toBe("failed");
    expect(call?.finishedAt).toBeTruthy();
    // How long it really ran is unknown: the process that ran it died without
    // saying when. Start-to-restart counted the downtime too (days,
    // for a call cut off by a shutdown), so it is not recorded at all.
    expect(call?.latencyMs).toBeNull();
    expect(call?.error).toEqual(expect.objectContaining({ name: "InterruptedLlmCall" }));
  } finally {
    restarted?.db.close();
  }
});

test("MandateStore filters LLM calls server-side", () => {
  const { store, cleanup } = tempStore();
  try {
    const summary = store.startLlmCall({
      purpose: "memory_summary_extraction",
      scopeType: "memory",
      scopeId: "mem-test",
      provider: "codex",
      model: "gpt-5.4-mini"
    });
    store.finishLlmCall(summary.id, {
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    });

    const wakeFailed = store.startLlmCall({
      purpose: "agent_wake_step",
      provider: "codex",
      model: "gpt-5.5"
    });
    store.finishLlmCall(wakeFailed.id, {
      status: "failed",
      errorJson: { message: "bad request" }
    });

    const wakeRunning = store.startLlmCall({
      purpose: "agent_wake_step",
      provider: "anthropic",
      model: "claude-sonnet"
    });

    expect(store.listLlmCalls(10, { status: "succeeded" }).map((c) => c.id)).toEqual([summary.id]);
    expect(store.listLlmCalls(10, { status: "failed" }).map((c) => c.id)).toEqual([wakeFailed.id]);
    expect(store.listLlmCalls(10, { status: "running" }).map((c) => c.id)).toEqual([
      wakeRunning.id
    ]);
    expect(
      store
        .listLlmCalls(10, { purpose: "agent_wake_step" })
        .map((c) => c.id)
        .sort()
    ).toEqual([wakeFailed.id, wakeRunning.id].sort());
    expect(
      store.listLlmCalls(10, { provider: "codex", model: "gpt-5.5" }).map((c) => c.id)
    ).toEqual([wakeFailed.id]);
    expect(store.listLlmCalls(10, { q: summary.id.slice(0, 8) }).map((c) => c.id)).toEqual([
      summary.id
    ]);
  } finally {
    cleanup();
  }
});

test("listFeatureWindowKeys: returns sessionName:windowName for every active feature in every active project", () => {
  const { store, projects, features, cleanup } = tempStore();
  try {
    const aId = seedProject(projects, { name: "A", workingDir: "/a", tmuxSessionName: "md-a" });
    const bId = seedProject(projects, { name: "B", workingDir: "/b", tmuxSessionName: "md-b" });
    seedFeature(features, aId, { name: "f1", tmuxWindowName: "f1" });
    seedFeature(features, aId, { name: "f2", tmuxWindowName: "f2" });
    seedFeature(features, bId, { name: "f3", tmuxWindowName: "f3" });

    const keys = [...store.listFeatureWindowKeys()].sort();
    expect(keys).toEqual(["md-a:f1", "md-a:f2", "md-b:f3"]);
  } finally {
    cleanup();
  }
});

test("listFeatureWindowKeys: excludes archived projects and archived features", () => {
  const { store, projects, features, cleanup } = tempStore();
  try {
    const liveProj = seedProject(projects, {
      name: "Live",
      workingDir: "/live",
      tmuxSessionName: "md-live"
    });
    const deadProj = seedProject(projects, {
      name: "Dead",
      workingDir: "/dead",
      tmuxSessionName: "md-dead"
    });
    seedFeature(features, liveProj, { name: "live-f", tmuxWindowName: "live-f" });
    seedFeature(features, liveProj, { name: "dead-f", tmuxWindowName: "dead-f" });
    seedFeature(features, deadProj, { name: "x", tmuxWindowName: "x" });

    projects.archive(deadProj);
    const rows = features.listActiveByProject(liveProj);
    const deadFeatRow = rows.find((r) => r.tmuxWindowName === "dead-f")!;
    features.archive(deadFeatRow.id);

    const keys = [...store.listFeatureWindowKeys()].sort();
    expect(keys).toEqual(["md-live:live-f"]);
  } finally {
    cleanup();
  }
});

test("MandateStore agent_threads unique index allows reuse after archive", () => {
  const { store, cleanup } = tempStore();
  try {
    store.db
      .prepare(
        `insert into agent_threads(id, scope, scope_id, created_at, updated_at)
       values('t1','feature','feat-1','x','x')`
      )
      .run();
    // Same active scope_id must collide
    expect(() =>
      store.db
        .prepare(
          `insert into agent_threads(id, scope, scope_id, created_at, updated_at)
       values('t2','feature','feat-1','x','x')`
        )
        .run()
    ).toThrow();
    // Archive then re-insert must succeed
    store.db.prepare("update agent_threads set archived_at='now' where id='t1'").run();
    store.db
      .prepare(
        `insert into agent_threads(id, scope, scope_id, created_at, updated_at)
       values('t2','feature','feat-1','x','x')`
      )
      .run();
  } finally {
    cleanup();
  }
});

describe("opening a store while another connection holds the lock", () => {
  const HOLD_MS = 400;
  const HELPER = path.join(import.meta.dirname, "helpers", "hold-db-lock.ts");

  /** Resolves once the child has printed the line saying it holds the lock. */
  async function waitForLock(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`lock helper exited without locking: ${seen}`);
      seen += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
  }

  test("opening a store waits out a lock another connection is holding", async () => {
    const dir = tempDir("md-open-contention-");
    const child = Bun.spawn([process.execPath, HELPER, path.join(dir, "mandate.db"), String(HOLD_MS)], {
      stdout: "pipe",
      stderr: "inherit"
    });

    try {
      await waitForLock(child.stdout);

      // `pragma journal_mode = wal` takes a brief exclusive lock. Set after it,
      // busy_timeout cannot cover it, and this call fails in about a millisecond
      // with "database is locked" — which is the e2e flake, in miniature.
      const started = Date.now();
      const store = new MandateStore(dir);
      const elapsed = Date.now() - started;
      store.db.close();

      // Having waited is the whole assertion: returning immediately would mean
      // the lock was never held, and the test would be proving nothing.
      expect(elapsed).toBeGreaterThan(HOLD_MS / 2);
    } finally {
      await child.exited;
    }
  });
});

describe("paging the LLM calls", () => {
  /**
   * Seeds one call at an exact timestamp. Sharing a `created_at` across rows is
   * the whole point here: `nowIso()` is whole-millisecond, so parallel agent
   * wakes can land several calls in one, and that is where a cursor that carries
   * only a timestamp loses rows.
   */
  function seed(db: import("bun:sqlite").Database, id: string, createdAt: string) {
    db.prepare(`
      insert into llm_calls
        (id, purpose, provider, request_hash, response_hash, status,
         started_at, finished_at, latency_ms, created_at, updated_at)
      values (?, 'agent_wake_step', 'openai-compatible', 'rq', 'rs', 'succeeded',
              ?, ?, 100, ?, ?)
    `).run(id, createdAt, createdAt, createdAt, createdAt);
  }

  type PagedRow = { id: string; createdAt: string };
  type Pager = {
    listLlmCallSummaries: (limit: number, filters: Record<string, string>) => PagedRow[];
  };

  /** Walks every page the way the Logs tab does, and returns the ids in order. */
  function pageThrough(store: Pager, pageSize: number): string[] {
    const seen: string[] = [];
    let cursor: { before: string; beforeId: string } | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = store.listLlmCallSummaries(pageSize, cursor ?? {});
      if (page.length === 0) break;
      seen.push(...page.map((row) => row.id));
      const last = page[page.length - 1]!;
      cursor = { before: last.createdAt, beforeId: last.id };
    }
    return seen;
  }

  test("paging past a boundary that several calls share loses none of them", () => {
    const env = freshStoresEnv("md-llm-page-");
    // Five calls in one millisecond, with a distinct call on either side. A
    // page size of two puts the boundary inside the shared group twice over.
    seed(env.store.db, "call_newest", "2026-08-04T00:00:02.000Z");
    for (let i = 0; i < 5; i += 1) {
      seed(env.store.db, `call_tied_${i}`, "2026-08-04T00:00:01.000Z");
    }
    seed(env.store.db, "call_oldest", "2026-08-04T00:00:00.000Z");

    const seen = pageThrough(env.store, 2);

    // Every row exactly once. With a timestamp-only cursor the second page asks
    // for `created_at < 00:00:01.000` and the three unread tied rows are gone.
    expect(seen.length).toBe(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen[0]).toBe("call_newest");
    expect(seen.at(-1)).toBe("call_oldest");
    // The tied rows keep one stable order rather than an arbitrary one, which
    // is what makes the cursor resumable at all.
    expect(seen.slice(1, 6)).toStrictEqual([
      "call_tied_4", "call_tied_3", "call_tied_2", "call_tied_1", "call_tied_0"
    ]);
  });

  test("a cursor without its id still pages, and is the reason the id is sent", () => {
    const env = freshStoresEnv("md-llm-page-legacy-");
    for (let i = 0; i < 3; i += 1) {
      seed(env.store.db, `call_tied_${i}`, "2026-08-04T00:00:01.000Z");
    }
    seed(env.store.db, "call_oldest", "2026-08-04T00:00:00.000Z");

    // `before` alone remains a legal cursor — the older behaviour — and this is
    // what it costs: asking past the tied group skips the two rows in it that
    // the first page did not return.
    const first = env.store.listLlmCallSummaries(1, {});
    const next = env.store.listLlmCallSummaries(10, { before: first[0]!.createdAt });
    expect(next.map((row: { id: string }) => row.id)).toEqual(["call_oldest"]);
  });
});
