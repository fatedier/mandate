import { expect, test } from "bun:test";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { planSteps, statementsRan } from "./helpers/sql-watch.js";

// Every step reads its thread's active window: what came after the latest
// summary, and the user's own turns that summary kept. A thread lives long
// (the personal agent's holds tens of thousands of rows), so the window is read by its
// range and the kept ids alone, never by walking the whole thread.

function say(agentStore: AgentStore, threadId: string, text: string, role: "user" | "assistant" = "user") {
  return agentStore.appendMessage(role === "user"
    ? { threadId, role, source: "user", content: { type: "text", text } }
    : { threadId, role, source: "self", content: { type: "assistant", text } });
}

function summarize(agentStore: AgentStore, threadId: string, kept: string[]) {
  return agentStore.appendMessage({
    threadId, role: "user", source: "compression",
    content: { type: "summary", summary: "what came before", replacedRange: [1, 1], replacedCount: 1, compactedCount: 1, retained: kept.map((id) => ({ id })) }
  });
}

test("the active window reads the rows after the summary and the kept ids, never the whole thread", () => {
  const env = freshAgentEnv("md-active-window-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-long");
  // Many short turns kept, as a user who writes briefly has: with a score of
  // kept ids SQLite would rather walk the thread than look each one up.
  const kept = Array.from({ length: 25 }, (_, i) => say(env.agentStore, thread.id, `ask ${i}`).id);
  for (let i = 0; i < 40; i++) say(env.agentStore, thread.id, `step ${i}`, "assistant");
  const summary = summarize(env.agentStore, thread.id, kept);
  const after = say(env.agentStore, thread.id, "now the tests");

  const { result, ran: reads } = statementsRan(env.store.db, /from agent_messages/, () => env.agentStore.getActiveMessages(thread.id));
  expect(result.map((m) => m.id)).toEqual([...kept, summary.id, after.id]);

  expect(reads.length).toBeGreaterThan(1);
  for (const read of reads) {
    const plan = planSteps(env.store.db, read).filter((detail) => /^(SCAN|SEARCH) (m|agent_messages)\b/.test(detail));
    // Each read of the thread's rows is a range from the summary, a lookup
    // by id, or the summaries' own index: never all of the thread's rows.
    for (const step of plan) expect(step).toMatch(/seq>\?|\(id=\?\)|idx_agent_messages_compression/);
  }
});

test("a kept id of another thread stays out, and the kept turns come first, in their order", () => {
  const env = freshAgentEnv("md-active-window-order-");
  const mine = env.agentStore.getOrCreateThread("worker", "wkr-mine");
  const other = env.agentStore.getOrCreateThread("worker", "wkr-other");
  const elsewhere = say(env.agentStore, other.id, "someone else's words");
  const first = say(env.agentStore, mine.id, "first ask");
  say(env.agentStore, mine.id, "a reply", "assistant");
  const second = say(env.agentStore, mine.id, "second ask");
  summarize(env.agentStore, mine.id, [second.id]);
  const third = say(env.agentStore, mine.id, "third ask");
  // The latest summary decides: its kept turns, listed in any order, one of
  // them another thread's.
  const latest = summarize(env.agentStore, mine.id, [third.id, elsewhere.id, first.id]);
  const fourth = say(env.agentStore, mine.id, "fourth ask");

  expect(env.agentStore.getActiveMessages(mine.id).map((m) => m.id)).toEqual([first.id, third.id, latest.id, fourth.id]);
});
