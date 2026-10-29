import { useCallback } from "react";
import type { AgentMessage } from "@/store/agent-chat";
import { useProjectsStore } from "@/store/projects";
import type { GlobalHandoffDto } from "@shared/api/global-agent";
import { featureHref, threadHref } from "@/lib/feature-href";
import { foldOpenKey, rendersNothing, type TranscriptItem, type TranscriptRow } from "@/routes/window/chat/transcript-rows";
import type { ToolResultSpec } from "@/routes/window/chat/tool-run-summary";
import { threadNoticeOf } from "@shared/thread-notice";

/** The global agent's tools whose results read as cards, not as tool lines:
 *  something was sent. A wait with nothing sent (await_stop) is not among
 *  them: it is a line of its run. */
export const HANDOFF_TOOL_NAMES: ReadonlySet<string> = new Set(["message_feature", "send_to_thread"]);

/** The ids of the handoffs a transcript shows, sorted: what the page reads,
 *  and reads again when one appears. Those of the cards it draws, and those
 *  its notices name (a notice's name opens what its target said). A card
 *  needs its call as well as its result: a result whose call is on a page not
 *  loaded yet draws nothing. */
export function handoffIdsOf(messages: readonly AgentMessage[]): string[] {
  const calls = new Set<string>();
  for (const m of messages) {
    if (m.content.type === "assistant") for (const c of m.content.toolCalls ?? []) calls.add(c.toolCallId);
  }
  const ids = new Set<string>();
  for (const m of messages) {
    for (const id of threadNoticeOf(m.content)?.handoffIds ?? []) ids.add(id);
    if (m.content.type !== "tool_result" || !HANDOFF_TOOL_NAMES.has(m.content.toolName) || !calls.has(m.content.toolCallId)) continue;
    const id = (m.content.result as { handoff?: { id?: unknown } } | undefined)?.handoff?.id;
    if (typeof id === "string") ids.add(id);
  }
  return [...ids].sort();
}

/** Whether a handoff call is drawn as a card and so leaves its run: its own
 *  card, when this row's calls made it. A call that was refused, or is still
 *  running, keeps its line. */
export function drawnAsHandoffCard(
  call: { toolName: string },
  result: ToolResultSpec | null | undefined,
  cardIds: ReadonlySet<string>
): boolean {
  if (!HANDOFF_TOOL_NAMES.has(call.toolName)) return false;
  const id = (result?.result as { handoff?: { id?: string } } | undefined)?.handoff?.id;
  if (!id) return false;
  return cardIds.has(id);
}

/** A card to draw: the handoff as its tool result gave it, until the store has it. */
export interface HandoffRef { id: string; dto: GlobalHandoffDto }

/** The cards a reply's own calls made, in the order it made them. */
export function handoffsCalledBy(steps: readonly AgentMessage[], results: ReadonlyMap<string, ToolResultSpec>): HandoffRef[] {
  const byId = new Map<string, GlobalHandoffDto>();
  for (const step of steps) {
    if (step.content.type !== "assistant") continue;
    for (const call of step.content.toolCalls ?? []) {
      if (!HANDOFF_TOOL_NAMES.has(call.toolName)) continue;
      const dto = (results.get(call.toolCallId)?.result as { handoff?: GlobalHandoffDto } | undefined)?.handoff;
      if (dto?.id) byId.set(dto.id, dto);
    }
  }
  return [...byId].map(([id, dto]) => ({ id, dto }));
}

/** Which row draws which cards. The agent sends with a call and then says
 *  where it went; drawn where the call was, the card stood above that
 *  sentence. A card is drawn under the first row of its turn that says
 *  anything, from the call's own row on (a row's words come before its
 *  calls, so its own words are about them). A row not of its turn that comes
 *  first (a notice, the user's message, an alarm, another reply) leaves the
 *  card where it was sent: a turn runs for minutes and takes those in, and the
 *  card must not pass them to land minutes later. While its turn is still
 *  writing and has said nothing since, the card follows the words so far
 *  (`trailing`), where they will be stored. So a card moves at most once. A
 *  call in no turn (a spoken one) keeps its card on its own row. A row that
 *  draws nothing neither takes a card nor holds one back, and nor does a send
 *  still on its way: drawn last meanwhile, it is stored after the words being
 *  written, since a running turn takes it in at its next step.
 *
 *  Every reply row has an entry, empty for one whose cards moved. */
export function turnHandoffs(
  rows: readonly TranscriptRow[],
  results: ReadonlyMap<string, ToolResultSpec>,
  streamingWakeId: string | null
): { byRow: Map<TranscriptRow, HandoffRef[]>; trailing: HandoffRef[] } {
  const byRow = new Map<TranscriptRow, HandoffRef[]>();
  const place = (row: TranscriptRow, cards: readonly HandoffRef[]) => byRow.set(row, [...(byRow.get(row) ?? []), ...cards]);
  // The cards of one turn that has said nothing since they were sent, each
  // with the row that sent it.
  let waiting: { wakeId: string; sent: Array<{ row: TranscriptRow; cards: HandoffRef[] }> } | null = null;
  const leaveWhereSent = () => {
    for (const { row, cards } of waiting?.sent ?? []) place(row, cards);
    waiting = null;
  };
  for (const row of rows) {
    if (row.kind === "pending" || rendersNothing(row)) continue;
    if (row.message.role !== "assistant") {
      leaveWhereSent();
      continue;
    }
    const cards = handoffsCalledBy([row.message, ...(row.runTail ?? [])], results);
    const wakeId = row.message.wakeId;
    if (waiting && waiting.wakeId !== wakeId) leaveWhereSent();
    if (!wakeId) {
      byRow.set(row, cards);
      continue;
    }
    byRow.set(row, []);
    waiting ??= { wakeId, sent: [] };
    if (cards.length > 0) waiting.sent.push({ row, cards });
    const says = row.message.content.type === "assistant" && Boolean(row.message.content.text?.trim());
    if (says) {
      place(row, waiting.sent.flatMap((s) => s.cards));
      waiting = null;
    }
  }
  const trailing: HandoffRef[] = [];
  if (waiting && waiting.wakeId === streamingWakeId) trailing.push(...waiting.sent.flatMap((s) => s.cards));
  else leaveWhereSent();
  return { byRow, trailing };
}

/** Whether a card's sent text opened in place pauses following, as a long
 *  message opened in place does and for the same reason
 *  (openFoldPausesFollow): opened at the end, it would be scrolled away by its
 *  own growth. Read from the cards the loaded rows draw, never from the marks
 *  alone. */
export function openSentTextPausesFollow(
  rows: readonly TranscriptItem[],
  results: ReadonlyMap<string, ToolResultSpec>,
  expandedIds: ReadonlySet<string>
): boolean {
  if (expandedIds.size === 0) return false;
  return rows.some((item) => item.kind === "msg" &&
    handoffsCalledBy([item.message, ...(item.runTail ?? [])], results).some((h) => expandedIds.has(foldOpenKey(h.id))));
}

/** Where each worker's chat is, by its feature id, while the worker is among the projects. */
export function useWorkerChatHrefs(): (featureId: string) => string | null {
  const projects = useProjectsStore((s) => s.projects);
  return useCallback((featureId: string) => {
    for (const project of projects) {
      const feature = project.features.find((f) => f.id === featureId);
      if (feature) return `${featureHref(project.tmuxSessionName, feature.tmuxWindowName)}?tab=chat`;
    }
    return null;
  }, [projects]);
}

/** Where a handoff went, as a place to open: the thread, or the worker's
 *  chat while the worker is among the projects. */
export function useHandoffHref(h: GlobalHandoffDto | null): string | null {
  const workerHref = useWorkerChatHrefs();
  if (!h) return null;
  if (h.kind === "feature") return h.featureId ? workerHref(h.featureId) : null;
  return h.threadId ? threadHref(h.threadId) : null;
}
