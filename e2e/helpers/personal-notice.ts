import type { Database } from "bun:sqlite";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { HandoffStore } from "../../src/server/modules/personal/handoff-store.js";
import { NO_TEXT_REPLY } from "../../src/shared/api/personal-agent.js";
import { formatThreadNoticeText, threadNoticeMetadata, type ThreadNotice, type ThreadNoticeStop } from "../../src/shared/thread-notice.js";

let seq = 0;

/** Seeds one exchange into the personal agent's conversation, as its turns
 *  leave it: the user asks, the agent sends to a thread (a card), the thread
 *  stops, and the notice's line stands over what the agent then said.
 *  `reply` is what the thread said when it stopped, null for nothing. */
export function seedThreadNotice(db: Database, agent: AgentStore, target: { threadId: string; title: string; stop: ThreadNoticeStop; reply: string | null }): void {
  const n = ++seq;
  const handoffs = new HandoffStore(db);
  const personal = agent.getOrCreatePersonalThread();
  const sent = `Report on ${target.title}.`;
  const row = handoffs.insert({ personalThreadId: personal.id, kind: "thread", state: "delivered", text: sent, spoken: false, workerId: null, targetThreadId: target.threadId, newThreadTitle: null });
  // Delivered: its message is in the thread, marked as the agent's.
  const relayed = agent.appendMessage({ threadId: target.threadId, role: "user", source: "user", content: { type: "text", text: sent, relay: { by: "personal", spoken: false, handoffId: row.id, name: "Mandate" } } });
  handoffs.transition(row.id, ["delivered"], { messageId: relayed.id, messageSeq: relayed.seq });
  const card = {
    id: row.id, kind: "thread", state: "delivered", text: sent, spoken: false, workerId: null, workerName: null, ownerThreadTitle: null,
    threadId: target.threadId, threadTitle: target.title, newThreadTitle: null, reply: null, reason: null, stop: null,
    createdAt: row.createdAt, updatedAt: row.updatedAt, repliedAt: null
  };
  const callId = `call_notice_${n}`;
  agent.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: `Ask ${target.title} for a report.` } });
  agent.appendMessage({ threadId: personal.id, role: "assistant", source: "self", wakeId: `w_send_${n}`, content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "send_to_thread", args: { threadId: target.threadId, text: sent } }] } });
  agent.appendMessage({ threadId: personal.id, role: "tool", source: "self", wakeId: `w_send_${n}`, content: { type: "tool_result", toolCallId: callId, toolName: "send_to_thread", result: { ok: true, handoff: card } } });
  agent.appendMessage({ threadId: personal.id, role: "assistant", source: "self", wakeId: `w_send_${n}`, content: { type: "assistant", text: `Sent it to ${target.title}.` } });
  handoffs.transition(row.id, ["delivered"], { state: "replied", reply: target.reply ?? NO_TEXT_REPLY, repliedAt: new Date().toISOString(), stop: target.stop });
  const notice: ThreadNotice = { handoffIds: [row.id], kind: "thread", targetThreadId: target.threadId, workerId: null, title: target.title, stop: target.stop, reason: null };
  agent.appendMessage({ threadId: personal.id, role: "user", source: "thread-notice", content: { type: "text", text: formatThreadNoticeText(notice, target.reply), metadata: threadNoticeMetadata(notice) } });
  agent.appendMessage({ threadId: personal.id, role: "assistant", source: "self", wakeId: `w_heard_${n}`, content: { type: "assistant", text: `${target.title} has stopped.` } });
}
