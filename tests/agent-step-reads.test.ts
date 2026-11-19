import { expect, test } from "bun:test";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { plansOf } from "./helpers/sql-watch.js";

// Reads every step makes: on a thread of tens of thousands of messages, one
// that walks the whole thread holds the server's only thread for a while.

function seeded() {
  const env = freshStoresEnv("md-agent-step-reads-");
  const thread = env.agentStore.createManagerThread("Release");
  env.agentStore.ensureSystemMessage(thread.id, "You are a manager.");
  for (let i = 0; i < 20; i++) env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: `reply ${i}`, toolCalls: [] } as never });
  return { env, thread };
}

test("a thread's system message is read at its start, without sorting the whole thread", () => {
  const { env, thread } = seeded();
  let text = "";
  const plans = plansOf(env.store.db, /m\.role = 'system' and m\.source = 'self'/, () => {
    const message = env.agentStore.getSystemMessage(thread.id);
    text = message?.content.type === "text" ? message.content.text : "";
  });
  expect(text).toBe("You are a manager.");
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("idx_agent_messages_thread_seq");
  expect(plans[0]).not.toContain("TEMP B-TREE");
});

test("the user's latest message in a thread is found through an index of its own, also in a thread where they never wrote", () => {
  const { env, thread } = seeded();
  const quiet = env.agentStore.createManagerThread("Quiet");
  for (let i = 0; i < 5; i++) env.agentStore.appendMessage({ threadId: quiet.id, role: "assistant", source: "self", content: { type: "assistant", text: `note ${i}`, toolCalls: [] } as never });
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go on" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context]" } });
  const found: unknown[] = [];
  const plans = plansOf(env.store.db, /role = 'user' and (m\.)?source in \('user', 'voice'\)/, () => {
    found.push(env.agentStore.latestPersonMessageSeq(thread.id));
    found.push(env.agentStore.latestPersonMessageSeq(quiet.id));
    found.push(env.agentStore.latestPersonMessageBefore(thread.id, Number.MAX_SAFE_INTEGER)?.id);
  });
  expect(found).toEqual([said.seq, 0, said.id]);
  expect(plans).toHaveLength(3);
  for (const plan of plans) expect(plan).toContain("idx_agent_messages_person");
});
