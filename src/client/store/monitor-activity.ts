import { create } from "zustand";
import { leadWait, type WaitKind } from "@shared/thread-dot";
import type {
  AgentMonitorsRevision,
  AgentPendingMonitorDto,
  AgentPendingMonitorsResponse,
  AgentPendingMonitorThreadDto
} from "@shared/api/agents";
import { api } from "@/lib/api-paths";
import { monitorsRevisionBefore } from "@/store/agent-chat-utils";

/** What a thread waits on: a pane (a watch) before a command (a monitor),
 *  before a subagent's result, before a command it runs in the background. */
export type MonitorWait = WaitKind;

export interface WaitingThread {
  scope: AgentPendingMonitorThreadDto["scope"];
  scopeId: string | null;
  /** Null once its waits ended; the entry stays for its revision. */
  waitsOn: MonitorWait | null;
  /** The waits themselves, in the order registered: what a worker's row on
   *  its manager's strip names. */
  monitors: AgentPendingMonitorDto[];
  revision: AgentMonitorsRevision;
}

interface MonitorActivityState {
  /** threadId → what it waits on, as of its revision. */
  waitingByThread: Map<string, WaitingThread>;
  /** The revision of the last list taken. */
  listRevision: AgentMonitorsRevision | null;
  applyList: (list: AgentPendingMonitorsResponse) => void;
  changed: (event: AgentPendingMonitorThreadDto & { revision: AgentMonitorsRevision }) => void;
  /** Read the list; only the latest read applies. At boot and reconnect. */
  refetch: () => Promise<void>;
}

const waitsOn = (monitors: AgentPendingMonitorDto[]): MonitorWait | null => leadWait(monitors);

/**
 * What every thread's agent waits on, so the sidebar can draw a
 * thread whose agents all sleep on a monitor as watching: the list at boot
 * and on reconnect, agentMonitorsChanged in between. Both carry the server
 * feed's revision, one count across threads, so whichever is newer wins per
 * thread and neither has to replay the other: a list read before an event
 * cannot undo it, and an event the list already counted changes nothing.
 */
export const useMonitorActivityStore = create<MonitorActivityState>((set) => {
  let latestRead = 0;
  return {
    waitingByThread: new Map(),
    listRevision: null,

    // Only refetch applies a list, and only its latest read: a list never
    // comes in older than the one before it.
    applyList: (list) => set((s) => {
      const next = new Map<string, WaitingThread>();
      // What an event told after this list was read stays.
      for (const [threadId, held] of s.waitingByThread) {
        if (monitorsRevisionBefore(list.revision, held.revision)) next.set(threadId, held);
      }
      for (const thread of list.threads) {
        if (next.has(thread.threadId)) continue;
        next.set(thread.threadId, { scope: thread.scope, scopeId: thread.scopeId, waitsOn: waitsOn(thread.monitors), monitors: thread.monitors, revision: list.revision });
      }
      return { waitingByThread: next, listRevision: list.revision };
    }),

    changed: (event) => set((s) => {
      const held = s.waitingByThread.get(event.threadId)?.revision ?? s.listRevision;
      if (held && !monitorsRevisionBefore(held, event.revision)) return s;
      const waitingByThread = new Map(s.waitingByThread);
      waitingByThread.set(event.threadId, { scope: event.scope, scopeId: event.scopeId, waitsOn: waitsOn(event.monitors), monitors: event.monitors, revision: event.revision });
      return { waitingByThread };
    }),

    refetch: async () => {
      const read = ++latestRead;
      const res = await fetch(api.agentPendingMonitors);
      if (!res.ok) return;
      const body = (await res.json()) as AgentPendingMonitorsResponse;
      if (read !== latestRead || !Array.isArray(body.threads) || !body.revision) return;
      useMonitorActivityStore.getState().applyList(body);
    }
  };
});
