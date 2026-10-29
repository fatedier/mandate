import type { AgentMonitorsRevision, AgentPendingMonitorDto, AgentPendingMonitorThreadDto, AgentScope } from "../../../shared/api/agents.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { CommandMonitorRecord } from "./command-monitor-manager.js";
import type { StoredWatch } from "./window-watch-manager.js";
import type { BackgroundTaskDto } from "../../../shared/api/background-tasks.js";
import type { AlarmRecord } from "./agent-alarm-manager.js";

/** A task still to come back: queued, or running. */
function isOpenTask(task: BackgroundTaskDto): task is BackgroundTaskDto & { status: "queued" | "running" } {
  return task.status === "queued" || task.status === "running";
}

/** A thread's pending monitors, with the revision they are current as of. */
export interface PendingMonitorsSnapshot {
  monitors: AgentPendingMonitorDto[];
  revision: AgentMonitorsRevision;
}

/** Every thread that waits on something, as of one revision. */
export interface AllPendingMonitorsSnapshot {
  threads: AgentPendingMonitorThreadDto[];
  revision: AgentMonitorsRevision;
}

/** What a thread's agent is still waiting on, for its chat: the
 *  pane watches and command monitors registered and not yet fired, timed out
 *  or cancelled, and the subagents it started that are queued or running
 *  (each wakes it with its result). The managers and the subagent service
 *  say when a thread's set changes; the feed sends the whole current set,
 *  which the thread's page also reads on load.
 *
 *  Both carry one revision, so a page can tell which of a read and an event is
 *  newer: this server's boot, then the count of changes since. A count is
 *  exact within a boot, and a later boot is newer whatever its count, so no
 *  burst or restart can order a newer set behind an older one. Equal
 *  revisions mean the same set. */
export function createPendingMonitorFeed(deps: {
  sse: Pick<AgentSseEmitter, "emit">;
  listWatches: (threadId: string) => StoredWatch[];
  listCommands: (threadId: string) => CommandMonitorRecord[];
  /** The thread's subagents; the ones still queued or running are kept. */
  listTasks: (threadId: string) => BackgroundTaskDto[];
  /** The thread's alarms it waits on (schedule_wake): pending, or fired with
   *  their wake not started yet. */
  listAlarms?: (threadId: string) => AlarmRecord[];
  /** Threads that may have a pending monitor; repeats and threads whose
   *  waits all ended are fine. */
  threadIds: () => Iterable<string>;
  /** Whose thread it is, so a page that never read it knows which worker
   *  waits (the sidebar's watching state). */
  threadScope: (threadId: string) => { scope: AgentScope; scopeId: string | null } | null;
  now?: () => number;
}) {
  const pendingMonitors = (threadId: string): AgentPendingMonitorDto[] => {
    const panes = deps.listWatches(threadId).map((watch) => ({
      at: watch.createdAtMs,
      dto: {
        kind: "pane" as const,
        id: watch.id,
        windowKey: watch.windowKey,
        paneId: watch.paneId,
        paneName: watch.paneName,
        stableMs: watch.stableMs,
        timeoutAt: new Date(watch.timeoutAtMs).toISOString(),
        note: watch.note,
        createdAt: new Date(watch.createdAtMs).toISOString()
      }
    }));
    const commands = deps.listCommands(threadId).map((monitor) => ({
      at: Date.parse(monitor.createdAt),
      dto: {
        kind: "command" as const,
        id: monitor.id,
        command: monitor.command,
        description: monitor.description,
        everyMs: monitor.everyMs,
        wakeWhen: monitor.wakeWhen,
        timeoutAt: monitor.timeoutAt,
        note: monitor.note,
        createdAt: monitor.createdAt,
        runCount: monitor.runCount,
        // Its newest check: the record's lastRunAt also counts registration probes.
        lastRunAt: monitor.recentRuns[0]?.at ?? null,
        nextRunAt: monitor.nextRunAt,
        recentRuns: monitor.recentRuns
      }
    }));
    const tasks = deps.listTasks(threadId).filter(isOpenTask).map((task): { at: number; dto: AgentPendingMonitorDto } => ({
      at: Date.parse(task.createdAt),
      dto: task.kind === "command"
        ? { kind: "background-command", id: task.id, title: task.title, status: "running", createdAt: task.createdAt }
        : { kind: "subagent", id: task.id, title: task.title, status: task.status, createdAt: task.createdAt }
    }));
    const alarms = (deps.listAlarms?.(threadId) ?? []).filter((alarm) => alarm.status !== "canceled").map((alarm) => ({
      at: Date.parse(alarm.createdAt),
      dto: { kind: "alarm" as const, id: alarm.id, fireAt: alarm.fireAt, note: alarm.note, createdAt: alarm.createdAt }
    }));
    return [...panes, ...commands, ...tasks, ...alarms].sort((a, b) => a.at - b.at).map((entry) => entry.dto);
  };
  const owner = (threadId: string) => {
    const scope = deps.threadScope(threadId);
    return { scope: scope?.scope ?? null, scopeId: scope?.scopeId ?? null };
  };
  const boot = deps.now?.() ?? Date.now();
  let seq = 0;
  return {
    snapshot(threadId: string): PendingMonitorsSnapshot {
      return { monitors: pendingMonitors(threadId), revision: { boot, seq } };
    },
    /** Every thread with a pending monitor. The count is the feed's, not a
     *  thread's, so an event after this list is newer than it for any
     *  thread, and one before it is not. */
    all(): AllPendingMonitorsSnapshot {
      const threads = [...new Set(deps.threadIds())].sort()
        .map((threadId) => ({ threadId, ...owner(threadId), monitors: pendingMonitors(threadId) }))
        .filter((thread) => thread.monitors.length > 0);
      return { threads, revision: { boot, seq } };
    },
    changed(threadId: string): void {
      seq += 1;
      deps.sse.emit(SSE_EVENTS.agentMonitorsChanged, { threadId, ...owner(threadId), monitors: pendingMonitors(threadId), revision: { boot, seq } });
    }
  };
}
