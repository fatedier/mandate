import { useCallback } from "react";
import type { AgentMessage } from "@/store/agent-chat";
import { useProjectsStore } from "@/store/projects";
import type { PersonalHandoffDto } from "@shared/api/personal-agent";
import { threadHref, workerInThreadHref } from "@/lib/worker-href";
import type { ToolResultSpec } from "@/routes/window/chat/tool-run-summary";
import { threadNoticeOf } from "@shared/thread-notice";

/** The personal agent's tools whose results read as cards, not as tool lines:
 *  something was sent. A wait with nothing sent (await_stop) is not among
 *  them: it is a line of its run. */
export const HANDOFF_TOOL_NAMES: ReadonlySet<string> = new Set(["message_worker", "send_to_thread"]);

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

/** A card to draw: the handoff as its tool result gave it, until the store
 *  has it, and the task it was sent for (send_to_thread's task). */
export interface HandoffRef { id: string; dto: PersonalHandoffDto; taskId?: string }

/** The cards a reply's own calls made, in the order it made them. */
export function handoffsCalledBy(steps: readonly AgentMessage[], results: ReadonlyMap<string, ToolResultSpec>): HandoffRef[] {
  const byId = new Map<string, { dto: PersonalHandoffDto; taskId?: string }>();
  for (const step of steps) {
    if (step.content.type !== "assistant") continue;
    for (const call of step.content.toolCalls ?? []) {
      if (!HANDOFF_TOOL_NAMES.has(call.toolName)) continue;
      const dto = (results.get(call.toolCallId)?.result as { handoff?: PersonalHandoffDto } | undefined)?.handoff;
      const taskId = (call.args as { taskId?: unknown } | undefined)?.taskId;
      if (dto?.id) byId.set(dto.id, { dto, ...(typeof taskId === "string" && taskId.trim() ? { taskId: taskId.trim() } : {}) });
    }
  }
  return [...byId].map(([id, ref]) => ({ id, ...ref }));
}

/** Where each worker's chat is, by its worker id, while the worker is among the projects. */
export function useWorkerChatHrefs(): (workerId: string) => string | null {
  const projects = useProjectsStore((s) => s.projects);
  return useCallback((workerId: string) => {
    for (const project of projects) {
      const worker = project.workers.find((w) => w.id === workerId);
      if (worker) return worker.ownerThreadId ? workerInThreadHref(worker.ownerThreadId, worker.id, "chat") : null;
    }
    return null;
  }, [projects]);
}

/** Where a handoff went, as a place to open: the thread, or the worker's
 *  chat while the worker is among the projects. */
export function useHandoffHref(h: PersonalHandoffDto | null): string | null {
  const workerHref = useWorkerChatHrefs();
  if (!h) return null;
  if (h.kind === "worker") return h.workerId ? workerHref(h.workerId) : null;
  return h.threadId ? threadHref(h.threadId) : null;
}
