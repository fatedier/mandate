import type { AgentMessage, AgentStore } from "../agent/agent-store.js";
import type { UpwardInbox, UpwardMessage } from "../agent/upward-inbox.js";
import { cutKeepingWhole } from "../agent/tool-output-spool.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { DutyReportOutcome } from "../../../shared/api/schedules.js";
import type { ThreadStop } from "../../../shared/thread-dot.js";
import { formatThreadNoticeText, threadNoticeMetadata, type ThreadNotice } from "../../../shared/thread-notice.js";
import { wakeFailureText } from "../agent/manager-threads.js";
import type { ScheduleStore } from "./schedule-store.js";
import { dutyEmptyReply } from "./schedule-messages.js";

/** The words that mean "nothing for the personal agent this round". */
export const NO_REPORT = "NO_REPORT";

/** No report: NO_REPORT alone, or as the last line under a note the thread
 *  keeps for its own record. */
function isNoReport(text: string): boolean {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) === NO_REPORT;
}

/** What the personal agent's model is given of a report or a failed round's reply. */
const REPORT_MAX_CHARS = 4000;
/** What it is given of the user's own round: told quietly. */
const QUIET_MAX_CHARS = 1500;
/** What it is given of the error a failed round ended on. */
const ERROR_MAX_CHARS = 1000;
/** Marks the ask a duty thread gets after an empty last reply. */
const EMPTY_REPLY_ASK = "dutyEmptyReply";

export interface DutyReportsDeps {
  store: ScheduleStore;
  agentStore: Pick<AgentStore, "getThreadById" | "latestTurnEnd" | "latestPersonMessageSeq" | "latestAskBetween" | "userWordsInRound" | "getOrCreatePersonalThread" | "lastSeq" | "getLatestWakeForThread" | "wakeFailureStatus" | "queuedMailboxSources">;
  workersStore: Pick<WorkersStore, "getById">;
  inbox: UpwardInbox;
  /** How a duty thread stands, judged on its own (each of its turns
   *  reports): null while its own turn runs or waits to start. */
  stopOf: (threadId: string) => ThreadStop | null;
  /** The personal agent's open waits on the thread: one ending tells it the reply itself. */
  waitsOn: (threadId: string) => number;
  /** Personal agent's name, as the duty thread knows it. */
  agentName: () => string;
  onRecorded?: (threadId: string, messageId: string, outcome: DutyReportOutcome) => void;
  now: () => string;
  /** The open tasks the thread is linked to: its notices name them. */
  tasksOf?: (threadId: string) => Array<{ id: string; title: string }>;
}

/** A duty thread reports by its own rule: when a turn of its own ends (its
 *  workers may still work), its reply goes to the personal agent, unless it is
 *  NO_REPORT (isNoReport). An empty one is neither: the thread is asked once
 *  for its report. The user's own round is told quietly; a wait the personal
 *  agent holds tells the reply itself. Each reply is told once. */
export function createDutyReports(deps: DutyReportsDeps): { noteSettled(threadId: string): void } {
  const tasksOn = (target: string): Pick<ThreadNotice, "tasks"> => {
    const tasks = deps.tasksOf?.(target) ?? [];
    return tasks.length > 0 ? { tasks } : {};
  };
  const dutyThreadOf = (threadId: string): string | null => {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.archivedAt) return null;
    let target: string | null = null;
    if (thread.scope === "manager") target = thread.id;
    else if (thread.scope === "worker" && thread.scopeId) target = deps.workersStore.getById(thread.scopeId)?.ownerThreadId ?? null;
    return target && deps.store.isDutyThread(target) ? target : null;
  };

  /** A failed round, with or without a new reply: told once (by what the
   *  thread holds now), by the personal agent's own wait when one is open. */
  const tellFailed = (target: string, lastToldSeq: number, reply: AgentMessage | null): void => {
    const seq = deps.agentStore.lastSeq(target);
    if (seq <= lastToldSeq) return;
    const fresh = reply && reply.seq > lastToldSeq ? reply : null;
    const byWait = deps.waitsOn(target) > 0;
    const outcome: DutyReportOutcome = byWait ? "told_by_wait" : "sent";
    const latest = deps.agentStore.getLatestWakeForThread(target);
    const error = latest ? wakeFailureText(deps.agentStore, latest) : null;
    let wake: (() => void) | null = null;
    deps.store.transaction(() => {
      deps.store.setLastToldSeq(target, seq);
      if (fresh) deps.store.recordReport(fresh.id, target, outcome, deps.now());
      if (!byWait) {
        const personal = deps.agentStore.getOrCreatePersonalThread();
        const notice: ThreadNotice = {
          handoffIds: [], kind: "thread", targetThreadId: target, workerId: null,
          title: deps.agentStore.getThreadById(target)?.title ?? "", stop: "failed", duty: "failed",
          reason: error ? `Last error: ${cut(error, ERROR_MAX_CHARS, personal.id)}` : null,
          ...tasksOn(target)
        };
        const text = fresh?.content.type === "assistant" ? (fresh.content.text ?? "").trim() : "";
        wake = deps.inbox.post({
          to: personal.id, key: `thread:${target}`, kind: "lifecycle", lifecycleReason: "failed", source: "thread-notice", sourceThreadId: target,
          content: { type: "text", text: formatThreadNoticeText(notice, cut(text, REPORT_MAX_CHARS, personal.id)), metadata: threadNoticeMetadata(notice) }
        }).wake;
      }
    });
    (wake as (() => void) | null)?.();
    if (fresh) deps.onRecorded?.(target, fresh.id, outcome);
  };

  return {
    noteSettled(threadId) {
      const target = dutyThreadOf(threadId);
      if (!target) return;
      // Stopped, failed, or stopped on a question a worker of its left open
      // (the thread cannot ask the user: its report carries the decision).
      const stop = deps.stopOf(target);
      if (stop === null) return;
      const duty = deps.store.dutyThread(target);
      if (!duty) return;
      // The round's last word, an empty one included: that one says nothing.
      const reply = deps.agentStore.latestTurnEnd(target);
      if (stop === "failed") {
        tellFailed(target, duty.lastToldSeq, reply);
        return;
      }
      if (!reply || reply.seq <= duty.lastToldSeq) return;
      // Someone spoke after it: the round goes on.
      if (deps.agentStore.latestPersonMessageSeq(target) > reply.seq) return;
      const title = deps.agentStore.getThreadById(target)?.title ?? "";
      const text = reply.content.type === "assistant" ? (reply.content.text ?? "").trim() : "";
      const personal = deps.agentStore.getOrCreatePersonalThread();
      const base = { handoffIds: [], kind: "thread" as const, targetThreadId: target, workerId: null, title, reason: null, ...tasksOn(target) };
      let outcome: DutyReportOutcome;
      let message: UpwardMessage | null = null;
      // Told up to the reply, or past the ask a stopped turn left unanswered
      // after it: that ask was this round's, not the next one's.
      let toldSeq = reply.seq;
      const post = (notice: ThreadNotice, body: string, route: Pick<UpwardMessage, "kind" | "lifecycleReason">): UpwardMessage => ({
        to: personal.id, key: `thread:${target}`, ...route, source: "thread-notice", sourceThreadId: target,
        content: { type: "text", text: formatThreadNoticeText(notice, body), metadata: threadNoticeMetadata(notice) }
      });
      // The round is everything since what was last told, whatever turns and
      // workers it took: the owner's when the newest ask in it is their own.
      const ask = deps.agentStore.latestAskBetween(target, duty.lastToldSeq, reply.seq);
      const ownersRound = ask !== null && ask.source !== "schedule" && !(ask.content.type === "text" && ask.content.relay);
      if (ownersRound) {
        outcome = "owner_note";
        const words = cut(deps.agentStore.userWordsInRound(target, reply.seq, duty.lastToldSeq).join("\n\n"), QUIET_MAX_CHARS, personal.id);
        message = post({ ...base, stop: "stopped", duty: "owner_round", words }, cut(text, QUIET_MAX_CHARS, personal.id), { kind: "note" });
      } else if (deps.waitsOn(target) > 0) {
        outcome = "told_by_wait";
      } else if (text === "" && !isEmptyReplyAsk(ask)) {
        // One that landed with no reply after it (its turn stopped) was the
        // one ask: the round ends as no report.
        const landed = deps.agentStore.latestAskBetween(target, reply.seq, deps.agentStore.lastSeq(target) + 1);
        if (isEmptyReplyAsk(landed)) {
          outcome = "no_report";
          toldSeq = landed!.seq;
        } else {
          // Asked already: the ask is on its way, and the round goes on.
          if (deps.agentStore.queuedMailboxSources(target).includes("schedule")) return;
          deps.inbox.post({
            to: target, kind: "request", key: `thread:${target}`, source: "schedule", sourceThreadId: null,
            content: { type: "text", text: dutyEmptyReply(deps.agentName()), metadata: { [EMPTY_REPLY_ASK]: true } }
          }).wake();
          return;
        }
      } else if (text === "" || isNoReport(text)) {
        outcome = "no_report";
      } else {
        outcome = "sent";
        message = post({ ...base, stop: "stopped", duty: "report" }, cut(text, REPORT_MAX_CHARS, personal.id), { kind: "report" });
      }
      // Told and marked together: a refused write tells nothing, and the
      // next settle tries again. The wake goes after the commit.
      let wake: (() => void) | null = null;
      deps.store.transaction(() => {
        deps.store.setLastToldSeq(target, toldSeq);
        deps.store.recordReport(reply.id, target, outcome, deps.now());
        if (message) wake = deps.inbox.post(message).wake;
      });
      (wake as (() => void) | null)?.();
      deps.onRecorded?.(target, reply.id, outcome);
    }
  };
}

/** The ask after an empty reply: a second empty reply to it is no report. */
function isEmptyReplyAsk(ask: AgentMessage | null): boolean {
  return ask?.source === "schedule" && ask.content.type === "text" && ask.content.metadata?.[EMPTY_REPLY_ASK] === true;
}

function cut(text: string, max: number, threadId: string): string {
  return cutKeepingWhole(text, max, { threadId });
}
