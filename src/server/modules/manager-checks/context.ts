import type { AgentMessage, AgentStore } from "../agent/agent-store.js";

/** What the manager-request-check judge reads of a thread: the request, then
 *  everything that happened in the thread since it went in, then the
 *  thread's latest reply. Cut so one judgement stays small; the request and
 *  the latest reply are always kept, the oldest events go first. */

const REQUEST_MAX = 4000;
const LATEST_MAX = 12_000;
const MANAGER_TEXT_MAX = 2000;
const TOOL_ARGS_MAX = 800;
const TOOL_RESULT_MAX = 300;
const MESSAGE_MAX = 1500;
const CONTEXT_MAX = 60_000;

export interface ThreadEvent {
  at: string;
  line: string;
}

/** The thread's rows after `afterSeq` (the request's) and before `beforeSeq`
 *  (the latest reply's), as lines. The runtime-context digests and the system
 *  prompt are not events. */
export function threadEventsSince(agentStore: Pick<AgentStore, "forEachNewestFirst">, threadId: string, afterSeq: number, beforeSeq: number): ThreadEvent[] {
  return eventsNewestFirst(agentStore, threadId, { afterSeq, beforeSeq });
}

/** The thread's rows after `afterSeq`, every one of them but `exceptSeq`
 *  (the reply judged, which has its own place), as lines: a reply that is
 *  latest may have words after it from turns that wrote none. */
export function threadEventsExcept(agentStore: Pick<AgentStore, "forEachNewestFirst">, threadId: string, afterSeq: number, exceptSeq: number): ThreadEvent[] {
  return eventsNewestFirst(agentStore, threadId, { afterSeq }, exceptSeq);
}

/** The events in a range, oldest first, read from the newest back and only
 *  as far as a judgement can keep (CONTEXT_MAX holds every part of it): the
 *  older ones would be cut from its context anyway. */
function eventsNewestFirst(
  agentStore: Pick<AgentStore, "forEachNewestFirst">,
  threadId: string,
  range: { afterSeq: number; beforeSeq?: number },
  exceptSeq?: number
): ThreadEvent[] {
  const newestFirst: ThreadEvent[] = [];
  let used = 0;
  agentStore.forEachNewestFirst(threadId, (message) => {
    if (message.seq === exceptSeq) return true;
    const lines = linesOf(message);
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = { at: message.createdAt, line: lines[i]! };
      newestFirst.push(event);
      used += renderedLength(event);
    }
    return used <= CONTEXT_MAX;
  }, range);
  return newestFirst.reverse();
}

/** An event's length in a judgement's context, its line break included. */
function renderedLength(event: ThreadEvent): number {
  return renderedLine(event).length + 1;
}

function renderedLine(event: ThreadEvent): string {
  return `[${shortTime(event.at)}] ${event.line}`;
}

function linesOf(message: AgentMessage): string[] {
  const content = message.content;
  if (message.role === "system" || message.source === "runtime-context") return [];
  if (content.type === "assistant") {
    return [
      ...(content.text?.trim() ? [`Manager: ${content.text.slice(0, MANAGER_TEXT_MAX)}`] : []),
      ...(content.toolCalls ?? []).map((call) => `Manager called ${call.toolName}(${jsonText(call.args).slice(0, TOOL_ARGS_MAX)})`)
    ];
  }
  if (content.type === "tool_result") {
    const result = content.isError ? content.error ?? "" : content.result;
    return [`${content.toolName} result: ${(typeof result === "string" ? result : jsonText(result)).slice(0, TOOL_RESULT_MAX)}`];
  }
  const text = content.type === "text" ? content.text : content.type === "summary" ? content.summary : "";
  if (!text.trim()) return [];
  return [`${sourceLabel(message)}: ${text.slice(0, MESSAGE_MAX)}`];
}

function sourceLabel(message: AgentMessage): string {
  if (message.source === "worker-report") return "Worker report";
  if (message.source === "worker-message") return "Worker message";
  if (message.source === "user") {
    return message.content.type === "text" && message.content.relay ? "Another request from the agent" : "User";
  }
  // Any other source, in a readable form of its name: "command-result" → "Command result".
  const words = message.source.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Message";
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/** `MM-DD HH:MM` of an ISO time, as the thread wrote it (UTC). */
function shortTime(iso: string): string {
  return iso.slice(5, 16).replace("T", " ");
}

export function renderManagerRequestCheckContext(input: {
  request: string;
  requestAt: string;
  events: readonly ThreadEvent[];
  latest: { text: string; at: string };
}): string {
  return renderJudgementContext({
    head: { label: "Request sent to the thread", text: input.request, at: input.requestAt },
    events: input.events,
    latest: input.latest
  });
}

/** A judgement's context: what it is about (the head), what happened in the
 *  thread since, oldest first, and the thread's latest reply. Without a head
 *  the events are the thread's from its start. */
export function renderJudgementContext(input: {
  head: { label: string; text: string; at: string } | null;
  events: readonly ThreadEvent[];
  latest: { text: string; at: string };
}): string {
  const head = input.head ? `${input.head.label} (${shortTime(input.head.at)}):\n${input.head.text.slice(0, REQUEST_MAX)}` : null;
  const latest = `The thread's latest reply (${shortTime(input.latest.at)}):\n${input.latest.text.slice(0, LATEST_MAX)}`;
  const lead = input.head ? "Everything in the thread since, oldest first:" : "Everything in the thread, oldest first:";
  // Less the blank lines between the parts and the line under the lead.
  const budget = CONTEXT_MAX - (head?.length ?? 0) - latest.length - lead.length - 5;
  const kept: string[] = [];
  let used = 0;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const event = input.events[i]!;
    const line = renderedLine(event);
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return [head, kept.length > 0 ? `${lead}\n${kept.join("\n")}` : null, latest].filter((part) => part !== null).join("\n\n");
}
