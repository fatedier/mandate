import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { ThreadStatusSnapshotDto, WaitingEntryDto } from "../../../shared/api/thread-status.js";
import { WAITING_WORD } from "../../../shared/status-words.js";

const MAX = 300;
const clip = (text: string) => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text);

/** A turn nobody asked for in that moment: a notice, a look the agent set,
 *  a subagent's result or a background command's end. */
const UNASKED_REASONS: ReadonlySet<string> = new Set(["thread-notice", "alarm", "subagent-result", "command-result", "schedule", "calendar"]);

/** The last thing the personal agent said in each turn a notice or an alarm
 *  started: one turn's, or that of every such turn
 *  that ended since a moment, oldest first. A turn that said nothing has no
 *  entry, and neither has one still running: what it has said so far is not
 *  its last word. */
export function saidAfterNotices(
  agentStore: Pick<AgentStore, "getWakeById" | "latestAssistantTextOfWake" | "wakeIdsFinishedSince">,
  threadId: string,
  query: { wakeId: string } | { since: string }
): Array<{ key: string; text: string }> {
  // By when the turn ended, not when the words were written: a turn can end
  // on a step with no words, long after its last ones.
  const wakeIds = "wakeId" in query
    ? (UNASKED_REASONS.has(agentStore.getWakeById(query.wakeId)?.reason ?? "") ? [query.wakeId] : [])
    : agentStore.wakeIdsFinishedSince(threadId, query.since, [...UNASKED_REASONS]);
  return wakeIds.flatMap((wakeId) => {
    const text = agentStore.latestAssistantTextOfWake(threadId, wakeId);
    return text ? [{ key: `said:${wakeId}`, text }] : [];
  });
}

/** A row Home lists, as it is said: "<title>: <word>." */
function waitingUpdateText(entry: WaitingEntryDto): string {
  return `${entry.threadTitle ?? entry.workerName ?? ""}: ${WAITING_WORD[entry.waiting].toLowerCase()}.`;
}

/** Where a session's updates start: what the agent said since voice was
 *  turned on that the user has not heard yet (its earlier sessions heard `heard`). */
export interface SpokenUpdatesFrom {
  since: string;
  heard: ReadonlySet<string>;
}

/** Feeds a voice session what to say unasked: what the agent said at the
 *  end of a turn a notice or an alarm started, and each row that comes onto
 *  Home's list (the personal agent's own question excepted: it is its own to say).
 *  Lives only while a session does. What the agent said comes with its key
 *  (`said:<wake id>`), so the session can say which ones were heard. */
export function startSpokenUpdateSource(deps: {
  sse: AgentSseEmitter;
  /** What Home lists now: rows already there when a session opens are not
   *  news. */
  waiting: () => readonly WaitingEntryDto[];
  /** The personal agent's conversation. */
  personalThreadId: () => string;
  /** What the agent said at the end of turns a notice or an alarm started:
   *  one turn's, or every such turn's since a moment, oldest first. */
  saidAfter?: (query: { wakeId: string } | { since: string }) => Array<{ key: string; text: string }>;
}): (cb: (text: string, key?: string) => void, from?: SpokenUpdatesFrom) => () => void {
  return (cb, from) => {
    // A row leaves the list and comes back: said again.
    let listed = new Set<string>(deps.waiting().map((entry) => entry.key));
    // Each is said once, and not at all once heard.
    const told = new Set<string>(from?.heard);
    const tell = (said: { key: string; text: string }) => {
      if (told.has(said.key)) return;
      told.add(said.key);
      cb(clip(said.text), said.key);
    };
    const stopSse = deps.sse.addSink((e) => {
      if (e.event === SSE_EVENTS.agentWakeFinished) {
        const { threadId, wakeId } = e.data as { threadId: string; wakeId: string };
        if (threadId === deps.personalThreadId()) for (const said of deps.saidAfter?.({ wakeId }) ?? []) tell(said);
      } else if (e.event === SSE_EVENTS.threadStatus) {
        const { waiting } = e.data as ThreadStatusSnapshotDto;
        for (const entry of waiting) {
          if (!listed.has(entry.key) && entry.kind !== "agent") cb(clip(waitingUpdateText(entry)));
        }
        listed = new Set(waiting.map((entry) => entry.key));
      }
    });
    // What was said while no session listened: as it opened, or while the
    // page was away.
    if (from && deps.saidAfter) for (const said of deps.saidAfter({ since: from.since })) tell(said);
    return stopSse;
  };
}
