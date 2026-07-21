import { expect, test } from "bun:test";
import { runCompression } from "../src/server/modules/agent/compression.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

const fresh = () => freshAgentEnv("md-cmp-side-");

/** A side thread's active window is derived by remapping inherited parent rows
 *  to carry the side thread's id while keeping their real ids. Compression runs
 *  over that derived window, so without care it records parent-owned ids in the
 *  side thread's summary — ids the side thread's own derivation can never
 *  resolve, because it selects on `m.thread_id = ?`. */

test("runCompression: a side thread retains only ids its own window can resolve", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const parent = agentStore.getOrCreateThread("worker", "feat-side-retain");
    const parentIntent = agentStore.appendMessage({
      threadId: parent.id, role: "user", source: "user",
      content: { type: "text", text: "parent intent" }
    });
    agentStore.appendMessage({
      threadId: parent.id, role: "assistant", source: "self",
      content: { type: "assistant", text: "parent answer" }
    });

    const side = agentStore.createSideThread(parent.id);
    agentStore.appendMessage({
      threadId: side.id, role: "assistant", source: "self",
      content: { type: "text", text: "side detail ".repeat(20_000) }
    });
    const sideIntent = agentStore.appendMessage({
      threadId: side.id, role: "user", source: "user",
      content: { type: "text", text: "side intent" }
    });

    const before = agentStore.getActiveMessages(side.id);
    // The inherited parent turn is a retainable user turn in this window, and it
    // is what compression used to record.
    expect(before.map((m) => m.id)).toContain(parentIntent.id);

    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, side.id);

    const content = result!.summaryMessage.content as any;
    expect(content.retained).toEqual([{ id: sideIntent.id }]);
    // Every recorded id belongs to the thread whose summary records it, so the
    // summary only promises what its own derivation can deliver.
    for (const entry of content.retained as Array<{ id: string }>) {
      expect(agentStore.getMessageById(entry.id)?.threadId).toBe(side.id);
    }
    // Exactly once: every window row is either retained or counted as replaced.
    expect(result!.replacedCount).toBe(before.length - content.retained.length);

    const after = agentStore.getActiveMessages(side.id);
    expect(after.map((m) => m.id)).toEqual([sideIntent.id, result!.summaryMessage.id]);
    // The parent's own row and thread are untouched by the side compression.
    expect(agentStore.getMessageById(parentIntent.id)?.threadId).toBe(parent.id);
  } finally { cleanup(); }
});

test("runCompression: a side thread with no user turn of its own retains nothing", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const parent = agentStore.getOrCreateThread("worker", "feat-side-none");
    agentStore.appendMessage({
      threadId: parent.id, role: "user", source: "user",
      content: { type: "text", text: "parent intent" }
    });
    agentStore.appendMessage({
      threadId: parent.id, role: "assistant", source: "self",
      content: { type: "assistant", text: "parent answer" }
    });

    const side = agentStore.createSideThread(parent.id);
    agentStore.appendMessage({
      threadId: side.id, role: "assistant", source: "self",
      content: { type: "text", text: "side detail ".repeat(20_000) }
    });

    const before = agentStore.getActiveMessages(side.id);
    const result = await runCompression({
      agentStore,
      summarizer: async () => ({ summaryText: "summarized" })
    }, side.id);

    const content = result!.summaryMessage.content as any;
    // The only retainable user turn in the window belongs to the parent, so
    // nothing survives here — and the count says so.
    expect(content.retained).toEqual([]);
    expect(result!.replacedCount).toBe(before.length);

    const after = agentStore.getActiveMessages(side.id);
    expect(after.map((m) => m.id)).toEqual([result!.summaryMessage.id]);
  } finally { cleanup(); }
});

test("getActiveMessages: a retained id owned by another thread never surfaces", () => {
  const { agentStore, cleanup } = fresh();
  try {
    const other = agentStore.getOrCreateThread("worker", "feat-other-thread");
    const foreign = agentStore.appendMessage({
      threadId: other.id, role: "user", source: "user",
      content: { type: "text", text: "text from a different conversation" }
    });

    const thread = agentStore.getOrCreateThread("worker", "feat-owner-thread");
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "own first" }
    });
    const summary = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: {
        type: "summary", summary: "s", replacedRange: [1, 1], replacedCount: 1,
        retained: [{ id: foreign.id, truncatedText: "substituted text" }]
      } as any
    });

    // The thread filter sits outside the retained or-group. If an edit ever
    // moved it inside, another conversation's user text would enter this
    // thread's prompt.
    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([summary.id]);
    // No turn surfaces at all: neither the foreign row nor a substituted copy
    // of it. (The summary row still carries its own `retained` metadata; that
    // is the record, not a turn in the window.)
    expect(active.flatMap((m) => (m.content.type === "text" ? [m.content.text] : []))).toEqual([]);
    expect(agentStore.getMessageById(foreign.id)?.threadId).toBe(other.id);
  } finally { cleanup(); }
});
