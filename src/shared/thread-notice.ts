import type { AgentMessageContent } from "./agent-message-types.js";
import { optionsOf, type QuestionOption, type QuestionSettlement } from "./questions.js";
import type { StopVerdict } from "./thread-dot.js";

/** How the target of a wait stopped, or that it is gone; or, while it
 *  works on, that its manager said a request is done or cannot go on. */
export type ThreadNoticeStop = "failed" | "needs_you" | "stopped" | "archived" | "done" | "cannot";

/** What a notice tells of its target: how it stopped, that it asked the
 *  user a question while it works on, or that such a question was settled
 *  there without the agent. */
export type ThreadNoticeEvent = ThreadNoticeStop | "asked" | "settled";

/** The words the page and the model read. */
export const THREAD_NOTICE_LABEL: Record<ThreadNoticeEvent, string> = {
  failed: "failed",
  needs_you: "needs you",
  stopped: "stopped",
  archived: "archived",
  done: "says your request is done",
  cannot: "says your request cannot go on",
  asked: "asked a question",
  settled: "question settled"
};

/** What the global agent is told of something it waits on: that it stopped,
 *  or that it asked the user a question (the wait then stays open). */
export interface ThreadNotice {
  /** The waits this ends; for a question, the waits it was told to. */
  handoffIds: string[];
  kind: "thread" | "feature";
  /** The manager thread, or the worker's own chat. */
  targetThreadId: string | null;
  featureId: string | null;
  /** The thread's title, or the worker's name. */
  title: string;
  stop: ThreadNoticeEvent;
  /** Why, when the wait ended without the target stopping (archived, lost at a restart). */
  reason: string | null;
  /** What it asked the user, with the answers it suggested: for `asked`
   *  and `settled`. Its id names it to a later `settled`. */
  question?: { id?: string; text: string; options: QuestionOption[] };
  /** How the question closed: for `settled` only. */
  settled?: QuestionSettlement;
  /** The requests a `done` or `cannot` ends, each cut to its first 300 characters. */
  requests?: string[];
  /** What the manager stop check found of a `stopped` thread's latest reply, when it found it in time. */
  verdict?: StopVerdict;
  /** A round the user drove with the thread directly, which the agent did
   *  not send — its `stopped` end, ending no wait, an `asked` question in it,
   *  or a wait it ends `needs_you`: told without a wake, a decision too: the
   *  user has it in front of them. */
  direct?: boolean;
  /** What a `stopped` thread said after it answered the agent's request,
   *  no one's word since: ending no wait; told without a wake unless it
   *  waits for the user's decision. */
  after?: boolean;
}

/** The words the page reads for a quiet notice (`direct` or `after`): what it left. */
export const QUIET_NOTICE_LABEL: Record<Exclude<StopVerdict, "nothing">, string> = {
  result: "result to read",
  decision: "decision needed"
};

/** The user's own round with the thread: they have its reply in front of
 *  them, so it is told without a wake, whatever it left, and what it needs
 *  of the agent is the agent's to judge. */
const DIRECT_LINE = "The user wrote to this thread directly and has its reply in front of them; you did not send this round and were not woken for it. Whether anything in it needs you, now or later, is yours to judge; know it for what you tell the user and keep.";
/** What came after the thread answered the agent's request, by what it left
 *  the user: a decision is theirs to make, and the agent is woken to tell them. */
const AFTER_LINE: Record<Exclude<StopVerdict, "nothing">, string> = {
  result: "This came after the thread answered your request; you did not send this round, and nothing waits on you. Know it for what you tell the user and keep.",
  decision: "This came after the thread answered your request; you did not send this round. Tell the user now: the decision is theirs."
};

/** A question a thread's manager put to the user in the user's own round,
 *  told without a wake. */
const OWN_ROUND_QUESTION_LINE = "The user is talking with this thread directly and has this question in front of them; it is theirs to answer.";

/** The manager stop check's line on a `stopped` notice. */
const VERDICT_LINE: Record<StopVerdict, string> = {
  decision: "Manager stop check: its latest reply waits for a decision from the user.",
  result: "Manager stop check: its latest reply has a result for the user to read.",
  nothing: "Manager stop check: its latest reply leaves nothing for the user."
};

const METADATA_KEY = "threadNotice";

export function threadNoticeMetadata(notice: ThreadNotice): Record<string, unknown> {
  return { [METADATA_KEY]: { ...notice } };
}

export function threadNoticeOf(content: AgentMessageContent): ThreadNotice | null {
  if (content.type !== "text") return null;
  const raw = content.metadata?.[METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (key: string) => (typeof r[key] === "string" ? (r[key] as string) : null);
  const stop = text("stop");
  const kind = text("kind");
  if (!stop || !Object.hasOwn(THREAD_NOTICE_LABEL, stop) || (kind !== "thread" && kind !== "feature")) return null;
  const ofQuestion = stop === "asked" || stop === "settled";
  const question = ofQuestion ? questionOf(r.question) : null;
  // A notice of a question is the question: without one it says nothing.
  if (ofQuestion && !question) return null;
  const settled = stop === "settled" ? settlementOf(r.settled) : null;
  if (stop === "settled" && !settled) return null;
  const requests = Array.isArray(r.requests) ? r.requests.filter((item): item is string => typeof item === "string") : null;
  const verdict = stop === "stopped" ? text("verdict") : null;
  return {
    handoffIds: Array.isArray(r.handoffIds) ? r.handoffIds.filter((id): id is string => typeof id === "string") : [],
    kind,
    targetThreadId: text("targetThreadId"),
    featureId: text("featureId"),
    title: text("title") ?? "",
    stop: stop as ThreadNoticeEvent,
    reason: text("reason"),
    ...(question ? { question } : {}),
    ...(settled ? { settled } : {}),
    ...(requests ? { requests } : {}),
    ...(verdict && Object.hasOwn(VERDICT_LINE, verdict) ? { verdict: verdict as StopVerdict } : {}),
    ...(r.direct === true ? { direct: true } : {}),
    ...(r.after === true ? { after: true } : {})
  };
}

function questionOf(raw: unknown): NonNullable<ThreadNotice["question"]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, text, options } = raw as { id?: unknown; text?: unknown; options?: unknown };
  if (typeof text !== "string" || !text) return null;
  return { ...(typeof id === "string" && id ? { id } : {}), text, options: optionsOf(options) };
}

function settlementOf(raw: unknown): QuestionSettlement | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { how, answer } = raw as { how?: unknown; answer?: unknown };
  if (how === "answered") return typeof answer === "string" ? { how, answer } : null;
  return how === "skipped" || how === "withdrawn" ? { how } : null;
}

function settledLine(settled: QuestionSettlement): string {
  switch (settled.how) {
    case "answered": return `The user answered it there: ${settled.answer}`;
    case "skipped": return "The user skipped it.";
    case "withdrawn": return "Its manager took it back.";
  }
}

/** The notice as the agent's model reads it. `lastReply` is already cut;
 *  for the user's own round (`direct`) it holds what the user said. */
export function formatThreadNoticeText(notice: ThreadNotice, lastReply: string | null): string {
  const who = notice.kind === "feature"
    ? `Worker ${notice.title} (${notice.featureId ?? "unknown"})`
    : `Thread "${notice.title}" (${notice.targetThreadId ?? "unknown"})`;
  if (notice.stop === "asked" && notice.question) {
    const { text, options } = notice.question;
    return [
      `[Thread notice] ${who}: asked the user a question.`,
      `Question: ${text}`,
      ...(options.length > 0
        ? ["Suggested answers:", ...options.map((option, index) => `${index + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`)]
        : []),
      "The thread goes on working, and so does your wait on it.",
      // In a round Your agent started its prompt says what to do: answer the
      // user's way when they decided this before, else ask them.
      ...(notice.direct ? [OWN_ROUND_QUESTION_LINE] : [])
    ].join("\n");
  }
  if (notice.stop === "settled" && notice.question && notice.settled) {
    return [
      `[Thread notice] ${who}: its question to the user is settled.`,
      `Question: ${notice.question.text}`,
      settledLine(notice.settled),
      "If you put this question to the user too, take yours back with `withdraw_question`."
    ].join("\n");
  }
  if (notice.stop === "done" || notice.stop === "cannot") {
    return [
      `[Thread notice] ${who}: ${THREAD_NOTICE_LABEL[notice.stop]}.`,
      ...(notice.requests ?? []).map((request) => `Your request: ${request}`),
      "The thread goes on working on other things.",
      lastReply ? `Last reply:\n${lastReply}` : "It has said nothing since you began waiting."
    ].join("\n");
  }
  const lines = [`[Thread notice] ${who}: ${THREAD_NOTICE_LABEL[notice.stop]}.`];
  if (notice.stop === "stopped" && notice.verdict) lines.push(VERDICT_LINE[notice.verdict]);
  const left = notice.verdict === "decision" ? "decision" : "result";
  // The user's own round: a question it leaves them is theirs.
  if (notice.direct) lines.push(notice.stop === "needs_you" ? OWN_ROUND_QUESTION_LINE : DIRECT_LINE);
  else if (notice.after) lines.push(AFTER_LINE[left]);
  if (notice.reason) lines.push(notice.reason);
  // The user's own round carries what they said: they have the reply.
  // A question it ends on carries the reply that asks it.
  if (notice.direct && notice.stop !== "needs_you") {
    if (lastReply) lines.push(`The user said:\n${lastReply}`);
  } else {
    lines.push(lastReply ? `Last reply:\n${lastReply}` : "It has said nothing since you began waiting.");
  }
  return lines.join("\n");
}
