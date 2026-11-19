import type { AgentMessage } from "@/store/agent-chat";

/** The failure row Retry or Continue acts on: the thread's last message of
 *  any kind — hidden ones included, since a later wake that said nothing
 *  still leaves its empty reply — when it is a failure, nothing is being
 *  sent, and the thread is idle. The server decides the rest: it refuses a
 *  retry of anything but the thread's newest failed wake. */
export function actionableFailureId(messages: readonly AgentMessage[], pending: boolean, idle: boolean): string | null {
  if (pending || !idle) return null;
  let last: AgentMessage | null = null;
  for (const message of messages) if (!last || message.seq > last.seq) last = message;
  return last?.content.type === "wake_failure" ? last.id : null;
}
