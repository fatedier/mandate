import { expect, test } from "bun:test";
import { freshAgentEnv, freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { contentOf } from "./helpers/typed.js";

const freshStore = () => freshAgentEnv("md-agent-");

test("AgentStore.getOrCreateThread: creates on first call, returns existing on second", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const t1 = agentStore.getOrCreateThread("worker", "feat-A");
    const t2 = agentStore.getOrCreateThread("worker", "feat-A");
    expect(t1.id).toBe(t2.id);
    expect(t1.scope).toBe("worker");
    expect(t1.scopeId).toBe("feat-A");
    expect(t1.archivedAt).toBe(null);
  } finally {
    cleanup();
  }
});

test("AgentStore.getOrCreateThread: separate threads per scope_id", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const a = agentStore.getOrCreateThread("worker", "feat-A");
    const b = agentStore.getOrCreateThread("worker", "feat-B");
    expect(a.id).not.toBe(b.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.getThreadByScope: returns null when missing", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    expect(agentStore.getThreadByScope("worker", "nope")).toBe(null);
  } finally {
    cleanup();
  }
});

test("AgentStore.archiveThread: sets archived_at; new getOrCreate returns a new row", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const t1 = agentStore.getOrCreateThread("worker", "feat-A");
    agentStore.archiveThread(t1.id);
    const archived = agentStore.getThreadById(t1.id)!;
    expect(archived.archivedAt).toBeTruthy();
    const t2 = agentStore.getOrCreateThread("worker", "feat-A");
    expect(t1.id).not.toBe(t2.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.appendMessage: assigns monotonic seq; getActiveMessages returns in order", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const m1 = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "hello" }
    });
    const m2 = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      content: { type: "assistant", text: "hi back" }
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    const active = agentStore.getActiveMessages(thread.id);
    expect(active.length).toBe(2);
    expect(active[0].id).toBe(m1.id);
    expect(active[1].id).toBe(m2.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.getActiveMessages: derives prompt history from appended compression summaries", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const m1 = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "old" }
    });
    const m2 = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      content: { type: "assistant", text: "old reply" }
    });
    const summary = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "compression",
      content: {
        type: "summary",
        summary: "summarized",
        replacedRange: [1, 2],
        replacedCount: 2,
        retained: []
      }
    });
    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([summary.id]);
    const all = agentStore.getMessages(thread.id);
    expect(all).toEqual([m1, m2, summary]);
    const since = agentStore.getMessagesSince(thread.id, 0);
    expect(since.map((m) => m.id)).toEqual([m1.id, m2.id, summary.id]);
  } finally {
    cleanup();
  }
});

test("AgentStore.getMessagesPage: paginates desc with `before` seq", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    for (let i = 0; i < 5; i++) {
      agentStore.appendMessage({
        threadId: thread.id,
        role: "user",
        source: "user",
        content: { type: "text", text: `msg-${i}` }
      });
    }
    const page = agentStore.getMessagesPage(thread.id, { limit: 2 });
    expect(page.length).toBe(2);
    expect(contentOf(page[0], "text").text).toBe("msg-4");
    expect(contentOf(page[1], "text").text).toBe("msg-3");
    const next = agentStore.getMessagesPage(thread.id, { limit: 2, beforeSeq: page[1].seq });
    expect(contentOf(next[0], "text").text).toBe("msg-2");
  } finally {
    cleanup();
  }
});

test("AgentStore.createWake → updateWakeStepCount → finishWake lifecycle", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "go" }
    });
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: trigger.id
    });
    expect(wake.status).toBe("running");
    expect(wake.stepCount).toBe(0);

    agentStore.updateWakeStepCount(wake.id, 3);
    agentStore.finishWake(wake.id, "finished");

    const got = agentStore.getWakeById(wake.id)!;
    expect(got.status).toBe("finished");
    expect(got.stepCount).toBe(3);
    expect(got.finishedAt).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("AgentStore.getMessageIdsForWake: returns ids of messages produced by + triggering this wake", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "go" }
    });
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: trigger.id
    });
    const produced = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      wakeId: wake.id,
      content: { type: "assistant", text: "ok" }
    });
    const ids = agentStore.getMessageIdsForWake(wake.id);
    expect(ids.sort()).toEqual([trigger.id, produced.id].sort());
  } finally {
    cleanup();
  }
});

test("AgentStore messages expose wakeReason derived from wakeId", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "work-item-heartbeat",
      triggerMessageId: null
    });
    const produced = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      wakeId: wake.id,
      content: { type: "assistant", text: "checked active items" }
    });

    expect(produced.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getMessageById(produced.id)?.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getMessages(thread.id)[0]?.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getActiveMessages(thread.id)[0]?.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getMessagesPage(thread.id, { limit: 1 })[0]?.wakeReason).toBe(
      "work-item-heartbeat"
    );
    expect(agentStore.getMessagesSince(thread.id, 0)[0]?.wakeReason).toBe("work-item-heartbeat");
  } finally {
    cleanup();
  }
});

test("AgentStore.getContextUsage: returns latest wake input tokens", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context");
    const oldWake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: null
    });
    agentStore.updateWakeTokenUsage(oldWake.id, 10, 10);
    agentStore.finishWake(oldWake.id, "finished");
    const latestWake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: null
    });
    agentStore.updateWakeTokenUsage(latestWake.id, 42, 42);
    agentStore.finishWake(latestWake.id, "finished");

    expect(agentStore.getContextUsage(thread.id, 170).inputTokens).toBe(42);
    expect(agentStore.getContextUsage(thread.id, 170).budgetTokens).toBe(170);
  } finally {
    cleanup();
  }
});

// Until a model call measures the window again, nothing is known about its
// size. The estimate once shown here runs well above the provider's count
// for the same messages and does not see the system prompt or the tools; after
// a compaction started by hand it would have stayed on screen indefinitely.
test("AgentStore.getContextUsage: no figure between a compaction and the next measured call", async () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-compressed");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "large previous history ".repeat(500) }
    });
    const before = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    agentStore.updateWakeTokenUsage(before.id, 1000, 1000);
    agentStore.finishWake(before.id, "finished");
    expect(agentStore.getContextUsage(thread.id, 1700).inputTokens).toBe(1000);

    const summary = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: { type: "summary", summary: "compressed", replacedRange: [0, 0], replacedCount: 1, retained: [] }
    });
    expect(agentStore.getContextUsage(thread.id, 1700)).toEqual({
      inputTokens: null, budgetTokens: 1700, updatedAt: summary.createdAt, source: "compression_budget"
    });

    // The next call measures it, and the figure is back.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const after = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    agentStore.updateWakeTokenUsage(after.id, 240, 240);
    agentStore.finishWake(after.id, "finished");
    expect(agentStore.getContextUsage(thread.id, 1700).inputTokens).toBe(240);
  } finally {
    cleanup();
  }
});

// A compaction at a turn's gate happens inside that turn: the call that
// measures the compacted window belongs to a wake that started before the
// summary and may run for many more minutes. The figure counts from when it
// was measured, not from when its wake started or ends.
test("AgentStore.getContextUsage: a call later in the same running wake measures the compacted window", async () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-same-wake");
    const wake = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    agentStore.updateWakeTokenUsage(wake.id, 1000, 1000);
    await new Promise((resolve) => setTimeout(resolve, 2));
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: { type: "summary", summary: "compressed", replacedRange: [0, 0], replacedCount: 1, retained: [] }
    });
    // Compacted, and the wake's last figure is from before: nothing measured yet.
    expect(agentStore.getContextUsage(thread.id, 1700).inputTokens).toBe(null);

    await new Promise((resolve) => setTimeout(resolve, 2));
    agentStore.updateWakeTokenUsage(wake.id, 240, 1000);
    const usage = agentStore.getContextUsage(thread.id, 1700);
    expect(usage.inputTokens).toBe(240);
    // Still running: the time is the measurement's.
    expect(agentStore.getWakeById(wake.id)!.status).toBe("running");
    expect(Date.parse(usage.updatedAt!)).toBeGreaterThan(Date.parse(wake.startedAt));
  } finally {
    cleanup();
  }
});

test("AgentStore.ensureSystemMessage: replaces the stored prompt when the template changed", () => {
  const { agentStore, store, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-sys");

    const first = agentStore.ensureSystemMessage(thread.id, "old policy text");
    expect(first?.content).toEqual({ type: "text", text: "old policy text" });

    // Same text: no-op, same message row.
    const same = agentStore.ensureSystemMessage(thread.id, "old policy text");
    expect(same?.id).toBe(first!.id);

    // Template upgraded (e.g. a prompt policy change shipped): the stored
    // system message must pick it up instead of freezing the thread forever.
    const updated = agentStore.ensureSystemMessage(thread.id, "new policy text");
    expect(updated?.content).toEqual({ type: "text", text: "new policy text" });
    expect(agentStore.getSystemMessage(thread.id)?.content).toEqual({
      type: "text",
      text: "new policy text"
    });

    // Still exactly one system message; seq 0 preserved.
    const systemRows = store.db
      .prepare("select seq, content from agent_messages where thread_id = ? and role = 'system'")
      .all(thread.id) as { seq: number; content: string }[];
    expect(systemRows.length).toBe(1);
    expect(systemRows[0]!.seq).toBe(0);
    expect(JSON.parse(systemRows[0]!.content).text).toBe("new policy text");
  } finally { cleanup(); }
});

test("queued mailbox thread listing includes all durable turn messages", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const threadId = agentStore.createManagerThread("T").id;
    expect(agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);

    agentStore.enqueueMailboxMessage({
      threadId,
      role: "user",
      source: "manager",
      sourceThreadId: "caller-thread",
      content: { type: "text", text: "conversation message" }
    });
    expect(agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([threadId]);

    agentStore.drainMailboxToMessages(threadId, "wake-message");
    expect(agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);
    expect(agentStore.listMailboxMessagesDeliveredToWake("wake-message")).toHaveLength(1);
  } finally { cleanup(); }
});

test("queuedMailboxSources lists the sources of undelivered turn-starting messages only", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const threadId = agentStore.createManagerThread("T").id;
    const enqueue = (source: "worker-report" | "feature-message", triggerTurn = true) => agentStore.enqueueMailboxMessage({
      threadId, role: "user", source, sourceThreadId: "w", content: { type: "text", text: source }, triggerTurn
    });
    enqueue("worker-report");
    expect(agentStore.queuedMailboxSources(threadId)).toEqual(["worker-report"]);
    enqueue("feature-message", false);
    expect(agentStore.queuedMailboxSources(threadId)).toEqual(["worker-report"]);
    enqueue("feature-message");
    expect(agentStore.queuedMailboxSources(threadId).sort()).toEqual(["feature-message", "worker-report"]);
    agentStore.drainMailboxToMessages(threadId, "wk");
    expect(agentStore.queuedMailboxSources(threadId)).toEqual([]);
  } finally { cleanup(); }
});

test("drainMailboxToMessages: a delivered text message keeps the time it reached the mailbox", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const threadId = agentStore.createManagerThread("T").id;
    agentStore.enqueueMailboxMessage({
      threadId,
      role: "user",
      source: "page-result",
      sourceThreadId: null,
      content: { type: "text", text: "Saved the form" }
    });
    const [delivered] = agentStore.drainMailboxToMessages(threadId, "wk-arrival");
    const [item] = agentStore.listMailboxMessagesDeliveredToWake("wk-arrival");
    expect(item).toBeDefined();
    expect(delivered?.content).toEqual({ type: "text", text: "Saved the form", arrivedAt: item!.createdAt });
  } finally { cleanup(); }
});

// The summary an idle compaction writes is not the thread's activity; any
// other summary is.
test("an idle summary is not the thread's activity", () => {
  const env = freshStoresEnv("md-idle-activity-");
  try {
    const { agentStore, store } = env;
    const at = (id: string, when: string) => store.db.prepare("update agent_messages set created_at = ? where id = ?").run(when, id);
    const summary = (threadId: string, idle: boolean) => agentStore.appendMessage({
      threadId, role: "user", source: "compression",
      content: { type: "summary", summary: "The notes are drafted.", replacedRange: [0, 0], replacedCount: 2, retained: [], ...(idle ? { trigger: "idle" as const, idleMinutes: 55 } : {}) }
    });
    const thread = agentStore.createManagerThread("project-1 3.22 release");
    at(agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } }).id, "2026-01-01T10:00:00.000Z");
    at(summary(thread.id, true).id, "2026-01-01T11:00:00.000Z");
    expect(agentStore.lastActivityAt(thread.id)).toBe("2026-01-01T10:00:00.000Z");
    at(summary(thread.id, false).id, "2026-01-01T12:00:00.000Z");
    expect(agentStore.lastActivityAt(thread.id)).toBe("2026-01-01T12:00:00.000Z");

    const project = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
    const feature = seedFeature(env.features, project, { name: "notes", tmuxWindowName: "notes" });
    const worker = agentStore.getOrCreateThread("worker", feature);
    at(agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", content: { type: "text", text: "Working on it." } }).id, "2026-01-01T10:00:00.000Z");
    at(summary(worker.id, true).id, "2026-01-01T11:00:00.000Z");
    expect(agentStore.lastWorkerMessageAtInProject(project)).toBe("2026-01-01T10:00:00.000Z");
  } finally {
    env.cleanup();
  }
});

// What the user said in the round a reply ends: their own typed or spoken
// words since the thread's previous turn, nothing relayed, nothing empty.
test("userWordsInRound: the user's own words since the previous turn, typed or spoken, in order", () => {
  const { agentStore: store, cleanup } = freshStore();
  try {
    const thread = store.createManagerThread("Docs overhaul");
    const say = (text: string, extra: Record<string, unknown> = {}, source: "user" | "voice" = "user") =>
      store.appendMessage({ threadId: thread.id, role: "user", source, content: { type: "text", text, ...extra } });
    const turn = (texts: string[]) => {
      const wake = store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
      const rows = texts.map((text) => store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text } }));
      store.finishWake(wake.id, "finished");
      return { wake, last: rows.at(-1)! };
    };
    say("Older words, answered already.");
    turn(["Answered."]);
    say("This plan is far too complex.");
    say("Keep one rule list.", {}, "voice");
    say("", { attachments: [{ type: "image", id: "img_1", name: "a.png", mediaType: "image/png", data: "", sizeBytes: 1 }] });
    say("Ask the user about the date.", { relay: { by: "global", spoken: false, handoffId: "hof_1" } });
    const wake = store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Looking." } });
    say("And drop the appendix.");
    const reply = store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "One rule list now." } });
    store.finishWake(wake.id, "finished");
    expect(store.userWordsInRound(thread.id, reply.seq)).toEqual(["This plan is far too complex.", "Keep one rule list.", "And drop the appendix."]);
  } finally { cleanup(); }
});

test("userWordsInRound: replies written outside any wake still end their rounds", () => {
  const { agentStore: store, cleanup } = freshStore();
  try {
    const thread = store.createManagerThread("Docs overhaul");
    const say = (text: string) => store.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
    const answer = (text: string) => store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text } });
    say("First question.");
    answer("First answer.");
    say("Second question.");
    const reply = answer("Second answer.");
    expect(store.userWordsInRound(thread.id, reply.seq)).toEqual(["Second question."]);
  } finally { cleanup(); }
});

// One turn's last words, read by the turn's own rows: a worker's report and
// its reply ask this at every turn end, whatever the conversation's length.
test("latestAssistantTextOfWake: the turn's newest reply with words, trimmed; none for a turn that wrote none", () => {
  const { agentStore: store, cleanup } = freshStore();
  try {
    const thread = store.createManagerThread("Docs overhaul");
    const turn = (texts: Array<string | null>) => {
      const wake = store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
      for (const text of texts) {
        store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, content: text === null
          ? { type: "assistant", toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "ls" } }] }
          : { type: "assistant", text } });
      }
      store.finishWake(wake.id, "finished");
      return wake.id;
    };
    const earlier = turn(["Earlier turn's words."]);
    const wake = turn(["Looking.", "  Found it: the flag stays.  ", null, "\n\t "]);
    const silent = turn([null]);
    expect(store.latestAssistantTextOfWake(thread.id, wake)).toBe("Found it: the flag stays.");
    expect(store.latestAssistantTextOfWake(thread.id, earlier)).toBe("Earlier turn's words.");
    expect(store.latestAssistantTextOfWake(thread.id, silent)).toBe(null);
  } finally { cleanup(); }
});

test("latestAssistantTextOfWake: rows of one seq read newest written first, as the whole conversation lists them", () => {
  const { agentStore: store, store: db, cleanup } = freshStore();
  try {
    const thread = store.createManagerThread("Docs overhaul");
    const wake = store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    // Stored in the other order from their times: the time decides, as getMessages orders them.
    const later = store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, seq: 7, content: { type: "assistant", text: "The later one." } });
    const earlier = store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, seq: 7, content: { type: "assistant", text: "The earlier one." } });
    db.db.prepare("update agent_messages set created_at = ? where id = ?").run("2026-10-29T10:00:01.000Z", later.id);
    db.db.prepare("update agent_messages set created_at = ? where id = ?").run("2026-10-29T10:00:00.000Z", earlier.id);
    expect(store.latestAssistantTextOfWake(thread.id, wake.id)).toBe("The later one.");
    const whole = store.getMessages(thread.id).filter((m) => m.content.type === "assistant").at(-1)!;
    expect(whole.content.type === "assistant" && whole.content.text).toBe("The later one.");
  } finally { cleanup(); }
});
