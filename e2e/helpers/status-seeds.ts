import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { createManagerStopCheckStore } from "../../src/server/modules/manager-checks/stop/store.js";

/** The manager stop check on, on Decisions, with the seeded config's one chat model:
 *  without it no stored verdict shows. Nothing calls the model unless a
 *  thread stops while the test runs. */
export function managerStopCheckOn(dataDir: string): void {
  const file = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.agent = {
    ...config.agent,
    decisionsEnabled: true,
    decisionsModel: { model: "openai/gpt-5.5", reasoningEffort: "provider-default" },
    managerStopCheckEnabled: true
  };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** A manager thread that stopped on a reply the manager stop check found leaves the
 *  user `outcome`, unread: it reads blue, and Home lists it. */
export function seedJudgedThread(db: Database, agent: AgentStore, title: string, outcome: "decision" | "result", reply: string): string {
  const thread = agent.createManagerThread(title);
  agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `About ${title}` } });
  const said = agent.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: reply } });
  createManagerStopCheckStore(db).set(thread.id, { replySeq: said.seq, outcome, judgedAt: new Date().toISOString() });
  return thread.id;
}

/** A manager thread whose last turn failed with `message`: red, and on Home. */
export function seedFailedThread(agent: AgentStore, title: string, message: string): string {
  const thread = agent.createManagerThread(title);
  agent.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `About ${title}` } });
  const wake = agent.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  agent.finishWake(wake.id, "error", message);
  return thread.id;
}
