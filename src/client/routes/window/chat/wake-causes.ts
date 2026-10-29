import type { AgentMessage } from "@/store/agent-chat";
import type { AgentWakeReason } from "@shared/api-contracts";
import { triggerReason } from "./chatProvenance";
import { isModelOnlySource, isPageNoteSource } from "@shared/agent-message-types";

/** A row the transcript draws as nothing: the thread's system prompt, a
 *  runtime-context snapshot (a routing digest for the model, not an event), a
 *  plan reminder (a nudge for the model, not a message), a note about Your
 *  agent's page (the model's to read), and a reply that said
 *  nothing and called nothing — a wake with nothing to report, whatever woke it. */
export function isHiddenMessage(message: AgentMessage, runTail?: AgentMessage[]): boolean {
  if (message.role === "system") return message.content.type !== "wake_failure";
  if (message.role === "user" && (isModelOnlySource(message.source) || isPageNoteSource(message.source))) return true;
  return isEmptyReply(message) && !(runTail?.length);
}

function isEmptyReply(message: AgentMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.type === "assistant" &&
    !message.content.text?.trim() &&
    !(message.content.toolCalls?.length)
  );
}

type Row = { kind: "msg"; message: AgentMessage; runTail?: AgentMessage[] } | { kind: "pending" };

/** Each trigger message (a watch firing, an alarm, an analyzer event) joined to
 *  the reply its wake produced, so the transcript shows one cause line over
 *  that reply instead of an event row and then a reply. The reply is the next
 *  row that is drawn at all — a runtime snapshot between them is skipped —
 *  provided it is an assistant reply to a wake of the trigger's kind AND the
 *  first row of that wake: a trigger that lands while a wake of its kind is
 *  already talking (a second alarm mid-way through the first's) is not that
 *  wake's cause, and that wake has shown its line already. The joined trigger
 *  leaves the list and rides on its reply as `cause`; any other trigger (its
 *  wake said nothing, has not answered yet, or was already under way) stays
 *  where it is, a cause line on its own. Nothing is reordered. */
export function pairWakeCauses<T extends Row>(
  rows: T[],
  reasonOf: (message: AgentMessage) => AgentWakeReason | null
): Array<T & { cause?: AgentMessage }> {
  // A wake's first row among those drawn: its runtime snapshot carries the
  // wake id too, and comes first, but is not drawn.
  const firstRowOfWake = new Map<string, number>();
  rows.forEach((row, index) => {
    if (row.kind !== "msg" || !row.message.wakeId || isHiddenMessage(row.message, row.runTail)) return;
    if (!firstRowOfWake.has(row.message.wakeId)) firstRowOfWake.set(row.message.wakeId, index);
  });
  const causeAt = new Map<number, AgentMessage>();
  const joined = new Set<number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.kind !== "msg") continue;
    const reason = triggerReason(row.message);
    if (!reason) continue;
    let j = i + 1;
    while (j < rows.length) {
      const next = rows[j]!;
      if (next.kind !== "msg" || !isHiddenMessage(next.message, next.runTail)) break;
      j += 1;
    }
    const reply = rows[j];
    const opensItsWake = reply?.kind === "msg" && (!reply.message.wakeId || firstRowOfWake.get(reply.message.wakeId) === j);
    if (reply?.kind === "msg" && reply.message.role === "assistant" && opensItsWake && !causeAt.has(j) && reasonOf(reply.message) === reason) {
      causeAt.set(j, row.message);
      joined.add(i);
    }
  }
  const out: Array<T & { cause?: AgentMessage }> = [];
  rows.forEach((row, index) => {
    if (joined.has(index)) return;
    const cause = causeAt.get(index);
    out.push(cause ? { ...row, cause } : row);
  });
  return out;
}
