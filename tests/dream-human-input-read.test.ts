import { expect, test } from "bun:test";
import { latestHumanInputMs } from "../src/server/modules/memory/dream-job.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { plansOf } from "./helpers/sql-watch.js";

// The dream's tick asks when the user last wrote (typed or spoken): one row
// among hundreds of thousands of messages, found through an index of its
// own rather than by reading them all.
test("the user's latest message is found through its own index, not by reading every message", () => {
  const env = freshStoresEnv("md-dream-human-input-");
  const thread = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 20; i++) env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: `reply ${i}`, toolCalls: [] } as never });
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go on" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context]" } });
  const db = env.store.db;
  const plans = plansOf(db, /max\(created_at\)/, () => expect(latestHumanInputMs(db)).toBe(Date.parse(said.createdAt)));
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("idx_agent_messages_human_input");
});
