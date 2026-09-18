import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MandateStore } from "../src/server/app/store.js";
import { initializeDatabaseSchema } from "../src/server/platform/db/schema.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-db-interrupted-"));
  let restarted: MandateStore | null = null;
  try {
    const db = new Database(path.join(dir, "mandate.db"));
    initializeDatabaseSchema(db);
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
    expect(call?.latencyMs).toBeGreaterThan(0);
    expect(call?.error).toEqual(expect.objectContaining({ name: "InterruptedLlmCall" }));
  } finally {
    restarted?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
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

test("listFeatureWindowKeys: empty when no projects", () => {
  const { store, cleanup } = tempStore();
  try {
    expect([...store.listFeatureWindowKeys()]).toEqual([]);
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

test("MandateStore creates agent_threads, agent_messages, agent_wakes tables", () => {
  const { store, cleanup } = tempStore();
  try {
    const tables = store.db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r: any) => r.name);
    expect(tables.includes("agent_threads")).toBeTruthy();
    expect(tables.includes("agent_messages")).toBeTruthy();
    expect(tables.includes("agent_wakes")).toBeTruthy();

    // Sanity: write & read a thread row.
    store.db
      .prepare(
        `insert into agent_threads(id, scope, scope_id, created_at, updated_at)
       values(?, ?, ?, ?, ?)`
      )
      .run("t1", "feature", "feat-1", "2026-05-03", "2026-05-03");
    const row = store.db
      .prepare("select scope, scope_id from agent_threads where id=?")
      .get("t1") as any;
    expect(row.scope).toBe("feature");
    expect(row.scope_id).toBe("feat-1");
  } finally {
    cleanup();
  }
});

test("MandateStore agent_threads schema exposes current columns", () => {
  const { store, cleanup } = tempStore();
  try {
    const names = (store.db.prepare("pragma table_info(agent_threads)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(names).toEqual([
      "id",
      "scope",
      "scope_id",
      "kind",
      "parent_thread_id",
      "ephemeral",
      "fork_context_start_seq",
      "fork_context_end_seq",
      "closed_at",
      "created_at",
      "updated_at",
      "archived_at"
    ]);
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
