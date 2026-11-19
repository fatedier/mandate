import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { configJson } from "./helpers/config-file.js";
import { DIRECT_CHAT_QUIET_MS } from "../src/server/modules/personal/direct-chats.js";

let env: StoresEnv | null = null;
let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; env?.cleanup(); env = null; });

// The runtime's direct chats: a chat gone quiet reaches the personal agent as
// one thread notice that wakes it, its times in the zone it reads times in.
test("the runtime tells the personal agent of the user's direct chat once it went quiet, waking it", async () => {
  env = freshStoresEnv("md-direct-chats-runtime-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({ agent: { managerStopCheckEnabled: false } }));
  const runtime = testAgentRuntime(env, { timeZone: "Asia/Singapore" });
  dispose = () => runtime.dispose();
  const thread = env.agentStore.createManagerThread("Video migration");
  const said = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Ship it." } });
  const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: said.id });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Shipped.", toolCalls: [] } });
  env.agentStore.finishWake(turn.id, "finished");
  const quietSince = new Date(Date.now() - DIRECT_CHAT_QUIET_MS - 60_000);
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(quietSince.toISOString(), said.id);
  const personal = env.agentStore.getOrCreatePersonalThread();
  await runtime.directChats.tick();
  const mail = env.store.db.prepare("select content, trigger_turn from agent_mailbox where thread_id = ? and source = 'thread-notice'").all(personal.id) as Array<{ content: string; trigger_turn: number }>;
  expect(mail).toHaveLength(1);
  expect(mail[0]!.trigger_turn).toBe(1);
  const text = (JSON.parse(mail[0]!.content) as { text: string }).text;
  const shown = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Singapore", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(quietSince);
  expect(text.split("\n")[0]).toContain(`(${thread.id}): the user talked with it directly from `);
  expect(text.split("\n")[0]).toContain(`${shown} +08:00 (1 message)`);
  expect(text).toContain("The user said:\nShip it.\nIts latest reply:\nShipped.");
});
