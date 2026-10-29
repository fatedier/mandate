import type { AgentStore } from "../../agent/agent-store.js";
import type { HandoffRow } from "../../global/handoff-store.js";
import type { HandoffService } from "../../global/handoff-service.js";
import type { ThreadStop } from "../../../../shared/thread-dot.js";
import { logError } from "../../../platform/logger.js";
import { requestOutcomeFromDecision, type ManagerRequestCheckOutcome } from "./answer.js";
import { renderManagerRequestCheckContext, threadEventsSince } from "../context.js";
import { judgeChoice, type Judged, type JudgementCandidate, type JudgementChoice, type JudgementInput, type JudgementNotUsed } from "../judge.js";
import type { ReplyJudgementSubjectDto } from "../../../../shared/api/activity.js";
import requestPromptPath from "../prompts/manager-request-check.md" with { type: "file" };

/** Manager request check: is the work of a request the thread got done? */
export const MANAGER_REQUEST_CHOICE: JudgementChoice<ManagerRequestCheckOutcome> = {
  purpose: "manager_request_check",
  promptPath: requestPromptPath,
  options: ["done", "cannot", "working"],
  fromDecision: requestOutcomeFromDecision
};

/** Manager request check's judgement: done, cannot or working; null with no answer. */
export function judgeManagerRequest(
  candidates: readonly JudgementCandidate[],
  input: JudgementInput<ReplyJudgementSubjectDto>,
  opts: { timeoutMs?: number } = {}
): Promise<Judged<ManagerRequestCheckOutcome> | null> {
  return judgeChoice(candidates, input, MANAGER_REQUEST_CHOICE, opts);
}

/** Manager request check: after a manager's turn, while its thread still works,
 *  each request Your agent waits on there is judged once against the turn's
 *  reply; one judged done (or cannot go on) ends alone. Judging runs in the
 *  background and never holds up the thread or its normal stop notice. */
export function createManagerRequestCheck(deps: {
  agentStore: AgentStore;
  handoffs: Pick<HandoffService, "openRequestWaits" | "questionToldOpen" | "endJudged">;
  stopOf: (threadId: string) => ThreadStop | null;
  /** The route's models now; none, manager request check is off. */
  candidates: () => JudgementCandidate[];
  judge?: typeof judgeManagerRequest;
}) {
  const judge = deps.judge ?? judgeManagerRequest;
  /** `<handoff>:<reply seq>` already judged (or being judged). */
  const judged = new Set<string>();
  const running = new Set<Promise<void>>();

  const judgeTurn = async (
    threadId: string,
    rows: HandoffRow[],
    reply: { seq: number; text: string; at: string },
    candidates: JudgementCandidate[],
    /** Your agent had been told of an open question from the thread as the reply was judged. */
    toldOfQuestion: boolean
  ) => {
    const outcomes = await Promise.all(rows.map(async (row): Promise<[HandoffRow, Judged<ManagerRequestCheckOutcome> | null]> => {
      const context = renderManagerRequestCheckContext({
        request: row.text,
        requestAt: row.createdAt,
        events: threadEventsSince(deps.agentStore, threadId, row.messageSeq!, reply.seq),
        latest: { text: reply.text, at: reply.at }
      });
      const subject = { replySeq: reply.seq, replyAt: reply.at, handoffId: row.id, requestAt: row.createdAt };
      return [row, await judge(candidates, { threadId, context, subject })];
    }));
    // Answers that would end a wait (working ends none).
    const ending = (answer: ManagerRequestCheckOutcome) => outcomes.filter(([, judged]) => judged?.answer === answer) as Array<[HandoffRow, Judged<ManagerRequestCheckOutcome>]>;
    const done = ending("done");
    const cannot = ending("cannot");
    const notUsed = (judged: Array<[HandoffRow, Judged<ManagerRequestCheckOutcome>]>, reason: JudgementNotUsed) => {
      for (const [, one] of judged) one.notUsed(reason);
    };
    // Archived or deleted meanwhile: its waits were ended with it.
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.archivedAt) return notUsed([...done, ...cannot], "archived");
    // Stopped meanwhile: its stop ends the waits, with its latest reply.
    if (deps.stopOf(threadId)) return notUsed([...done, ...cannot], "stopped");
    // A newer reply came meanwhile: its own judgement speaks for the thread
    // now (an older reply judged slowly must not end a wait it kept open).
    // None found (steps that only call tools) is no newer reply.
    const latest = deps.agentStore.latestReply(threadId);
    if (latest && latest.seq > reply.seq) return notUsed([...done, ...cannot], "newer_reply");
    // A wait ended already: archiving and a newer reply are ruled out above,
    // so the thread's stop ended it, though it works again now.
    const end = (judged: Array<[HandoffRow, Judged<ManagerRequestCheckOutcome>]>, outcome: "done" | "cannot") => {
      const ended = new Set(deps.handoffs.endJudged(judged.map(([row]) => row), outcome, reply.text));
      for (const [row, one] of judged) if (!ended.has(row.id)) one.notUsed("stopped");
    };
    if (done.length > 0) end(done, "done");
    // Told of the thread's open question, the agent knows it waits for the
    // user; ending the wait would only lose the completion. An answer given
    // while the reply was judged closes the question, and the work goes on.
    if (cannot.length === 0) return;
    if (toldOfQuestion || deps.handoffs.questionToldOpen(threadId)) return notUsed(cannot, "question_open");
    end(cannot, "cannot");
  };

  return {
    /** A thread's turn ended and it was released. */
    noteTurnEnded(threadId: string): void {
      try {
        if (deps.agentStore.getThreadById(threadId)?.scope !== "manager") return;
        // Stopped: today's rule ends its waits.
        if (deps.stopOf(threadId)) return;
        const latest = deps.agentStore.latestReply(threadId);
        if (!latest || latest.content.type !== "assistant") return;
        // Its turn not released yet (its end not written), it may still be
        // stopped: that turn's release judges it.
        if (latest.wakeId && deps.agentStore.getWakeById(latest.wakeId)?.status === "running") return;
        const reply = { seq: latest.seq, text: latest.content.text ?? "", at: latest.createdAt };
        const rows = deps.handoffs.openRequestWaits(threadId)
          .filter((row) => row.messageSeq !== null && reply.seq > row.messageSeq && !judged.has(`${row.id}:${reply.seq}`));
        if (rows.length === 0) return;
        const candidates = deps.candidates();
        if (candidates.length === 0) return;
        for (const row of rows) judged.add(`${row.id}:${reply.seq}`);
        const run: Promise<void> = judgeTurn(threadId, rows, reply, candidates, deps.handoffs.questionToldOpen(threadId))
          .catch((err) => logError(`manager request check for thread ${threadId}`, err))
          .finally(() => { running.delete(run); });
        running.add(run);
      } catch (err) {
        logError(`manager request check for thread ${threadId}`, err);
      }
    },
    /** Resolves once no judgement is running (tests, shutdown). */
    async idle(): Promise<void> {
      while (running.size > 0) await Promise.allSettled([...running]);
    }
  };
}
