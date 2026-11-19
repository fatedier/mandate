import { formatCalendarDate } from "@/lib/format";
import type { AgentMessage } from "@/store/agent-chat";

/** A step of a wake that only called tools: no text of its own. */
function isToolOnlyStep(m: AgentMessage): boolean {
  return (
    m.role === "assistant" &&
    m.content.type === "assistant" &&
    !m.content.text?.trim() &&
    (m.content.toolCalls?.length ?? 0) > 0
  );
}

function callsTools(m: AgentMessage): boolean {
  return m.role === "assistant" && m.content.type === "assistant" && (m.content.toolCalls?.length ?? 0) > 0;
}

/** Joins each run of tool-only steps onto the step before it, when that step
 *  called tools too and belongs to the same wake: the stretch of tool work
 *  between two things the agent said then renders as one line. Most
 *  assistant messages are tool-only steps, each of which used to
 *  print its own clock and a card per call.
 *
 *  A wake boundary always breaks the run: the next wake's first message is
 *  where its provenance line ("ALARM 16:05") is drawn, and folding it into the
 *  previous wake's run would drop that line. A missing wake id never joins
 *  either, and neither does a step on another calendar day: the list heads
 *  each day with a date row, anchored on the first row of that day, so a run
 *  across midnight would file the later steps under the earlier date.
 *  Anything else between two steps — a user message, a monitor event — is its
 *  own item and breaks the run by being there. So does a step after which
 *  the run `endsRun`: one that sent a card, drawn under the run that sent it,
 *  so the work after it is a line of its own below the card. Pure: order
 *  kept, only tails attached. */
export function groupToolRuns<
  I extends { kind: "msg"; message: AgentMessage; runTail?: AgentMessage[] } | { kind: "pending" }
>(items: I[], endsRun?: (step: AgentMessage) => boolean, splitAfter?: number | null): I[] {
  const out: I[] = [];
  for (const item of items) {
    const head = out[out.length - 1];
    const last = head?.kind === "msg" ? head.runTail?.at(-1) ?? head.message : null;
    if (
      item.kind === "msg" &&
      head?.kind === "msg" &&
      last !== null &&
      !endsRun?.(last) &&
      // A run read up to `splitAfter` (the point the user had read to) ends
      // there: the steps after it are new to the reader.
      !(splitAfter != null && last.seq <= splitAfter && item.message.seq > splitAfter) &&
      isToolOnlyStep(item.message) &&
      callsTools(head.message) &&
      head.message.wakeId != null &&
      head.message.wakeId === item.message.wakeId &&
      formatCalendarDate(head.message.createdAt) === formatCalendarDate(item.message.createdAt)
    ) {
      out[out.length - 1] = { ...head, runTail: [...(head.runTail ?? []), item.message] } as I;
      continue;
    }
    out.push(item);
  }
  return out;
}
