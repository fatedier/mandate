import type { AgentMessageContent } from "./agent-message-types.js";
import { optionsOf, type QuestionOption, type QuestionSettlement } from "./questions.js";
import type { StopVerdict } from "./thread-dot.js";

/** How the target of a wait stopped, or that it is gone; or, while it
 *  works on, that its manager said a request is done or cannot go on. */
export type ThreadNoticeStop = "failed" | "needs_you" | "stopped" | "archived" | "done" | "cannot";

/** What a notice tells of its target: how it stopped, that it asked the
 *  user a question while it works on, that such a question was settled
 *  there without the agent, or the user's direct chat with it, gone quiet. */
export type ThreadNoticeEvent = ThreadNoticeStop | "asked" | "settled" | "chat";

/** The words the page and the model read. */
export const THREAD_NOTICE_LABEL: Record<ThreadNoticeEvent, string> = {
  failed: "failed",
  needs_you: "needs you",
  stopped: "stopped",
  archived: "archived",
  done: "says your request is done",
  cannot: "says your request cannot go on",
  asked: "asked a question",
  settled: "question settled",
  chat: "your direct chat"
};

/** What the personal agent is told of something it waits on: that it stopped,
 *  or that it asked the user a question (the wait then stays open). */
export interface ThreadNotice {
  /** The waits this ends; for a question, the waits it was told to. */
  handoffIds: string[];
  kind: "thread" | "worker";
  /** The manager thread, or the worker's own chat. */
  targetThreadId: string | null;
  workerId: string | null;
  /** The thread's title, or the worker's name. */
  title: string;
  stop: ThreadNoticeEvent;
  /** Why, when the wait ended without the target stopping (archived, lost at a restart). */
  reason: string | null;
  /** What it asked the user, with the answers it suggested: for `asked`
   *  and `settled`. Its id names it to a later `settled`. */
  question?: { id: string; text: string; options: QuestionOption[] };
  /** How the question closed: for `settled` only. */
  settled?: QuestionSettlement;
  /** The requests a `done` or `cannot` ends, each cut to its first 300 characters. */
  requests?: string[];
  /** What the manager stop check found of a `stopped` thread's latest reply, when it found it in time. */
  verdict?: StopVerdict;
  /** The owner's open tasks the thread is linked to: the notice names them. */
  tasks?: Array<{ id: string; title: string }>;
  /** A round the user drove with the thread directly, which the agent did
   *  not send, told to a conversation that waits on the thread: an `asked`
   *  question in it, or a wait it ends `needs_you`. Told without a wake: the
   *  user has it in front of them. What ends no wait is not told round by
   *  round: their direct chat is, once it went quiet (`chat`). */
  direct?: boolean;
  /** What a `stopped` thread said after it answered the agent's request,
   *  no one's word since: ending no wait; told without a wake unless it
   *  waits for the user's decision. */
  after?: boolean;
  /** An `asked` question from a thread the agent waits on nothing in: a
   *  manager's question always reaches it, or nobody would look. Woken for
   *  it, unless the round was the user's own (`direct`). */
  noWait?: boolean;
  /** A duty thread's round, told by its own rule rather than a wait: its
   *  report, the user's own round with it (told quietly), or a failed round. */
  duty?: DutyNotice;
  /** What the user said in a duty thread's `owner_round`, or in a direct chat. */
  words?: string;
  /** A `chat`: the user's first and last words in it (ISO), and how many
   *  messages they wrote. */
  chat?: { from: string; to: string; messages: number };
}

export type DutyNotice = "report" | "owner_round" | "failed";
const DUTY_NOTICES: readonly DutyNotice[] = ["report", "owner_round", "failed"];

/** The words the page reads for a quiet notice (`direct` or `after`): what it left. */
export const QUIET_NOTICE_LABEL: Record<Exclude<StopVerdict, "nothing">, string> = {
  result: "result to read",
  decision: "decision needed"
};

/** What came after the thread answered the agent's request, by what it left
 *  the user: a decision is theirs to make, and the agent is woken to tell them. */
const AFTER_LINE: Record<Exclude<StopVerdict, "nothing">, string> = {
  result: "This came after the thread answered your request; you did not send this round, and nothing waits on you. Know it for what you tell the user and keep.",
  decision: "This came after the thread answered your request; you did not send this round. Tell the user now: the decision is theirs."
};

/** A question a thread's manager put to the user in the user's own round,
 *  told without a wake. */
const OWN_ROUND_QUESTION_LINE = "The user is talking with this thread directly and has this question in front of them; it is theirs to answer.";

/** A question from a thread the agent waits on nothing in, in a round not the user's own. */
const NO_WAIT_QUESTION_LINE = "You were not waiting on this thread: it asked the user on its own. Tell the user now: the question is theirs.";

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
  if (!stop || !Object.hasOwn(THREAD_NOTICE_LABEL, stop) || (kind !== "thread" && kind !== "worker")) return null;
  const chat = stop === "chat" ? chatOf(r.chat) : null;
  // A chat says when it was: without its span it says nothing.
  if (stop === "chat" && !chat) return null;
  const ofQuestion = stop === "asked" || stop === "settled";
  const question = ofQuestion ? questionOf(r.question) : null;
  // A notice of a question is the question: without one it says nothing.
  if (ofQuestion && !question) return null;
  const settled = stop === "settled" ? settlementOf(r.settled) : null;
  if (stop === "settled" && !settled) return null;
  const requests = Array.isArray(r.requests) ? r.requests.filter((item): item is string => typeof item === "string") : null;
  // A chat carries only the decision its thread waits for.
  const verdict = stop === "stopped" || (stop === "chat" && text("verdict") === "decision") ? text("verdict") : null;
  return {
    handoffIds: Array.isArray(r.handoffIds) ? r.handoffIds.filter((id): id is string => typeof id === "string") : [],
    kind,
    targetThreadId: text("targetThreadId"),
    workerId: text("workerId"),
    title: text("title") ?? "",
    stop: stop as ThreadNoticeEvent,
    reason: text("reason"),
    ...(question ? { question } : {}),
    ...(settled ? { settled } : {}),
    ...(requests ? { requests } : {}),
    ...(verdict && Object.hasOwn(VERDICT_LINE, verdict) ? { verdict: verdict as StopVerdict } : {}),
    ...(r.direct === true ? { direct: true } : {}),
    ...(r.after === true ? { after: true } : {}),
    ...(r.noWait === true ? { noWait: true } : {}),
    ...(DUTY_NOTICES.includes(r.duty as DutyNotice) ? { duty: r.duty as DutyNotice } : {}),
    ...(text("words") !== null ? { words: text("words")! } : {}),
    ...(chat ? { chat } : {}),
    ...(tasksOf(r.tasks) ? { tasks: tasksOf(r.tasks)! } : {})
  };
}

function tasksOf(raw: unknown): Array<{ id: string; title: string }> | null {
  if (!Array.isArray(raw)) return null;
  const tasks = raw.flatMap((t) => (t && typeof t === "object" && typeof (t as { id?: unknown }).id === "string" && typeof (t as { title?: unknown }).title === "string"
    ? [{ id: (t as { id: string }).id, title: (t as { title: string }).title }]
    : []));
  return tasks.length > 0 ? tasks : null;
}

/** The line that names a notice's tasks, under its first line. */
function withTasks(text: string, tasks: ThreadNotice["tasks"]): string {
  if (!tasks || tasks.length === 0) return text;
  const named = tasks.map((t) => `"${t.title}" (${t.id})`).join(", ");
  const line = `Linked to ${tasks.length === 1 ? "task" : "tasks"}: ${named}`;
  const cut = text.indexOf("\n");
  return cut < 0 ? `${text}\n${line}` : `${text.slice(0, cut)}\n${line}${text.slice(cut)}`;
}

/** A duty thread's notice, in fixed wording the personal agent reads. */
function formatDutyNotice(notice: ThreadNotice, lastReply: string | null): string {
  const who = `Duty thread "${notice.title}" (${notice.targetThreadId ?? "unknown"})`;
  switch (notice.duty) {
    case "owner_round":
      return [
        `[Thread notice] ${who}: the user wrote to it directly and has its reply in front of them; you did not send this round and nothing waits on you. Keep it in mind for your page and for what you tell the user.`,
        `The user said:\n${notice.words ?? ""}`,
        `Its reply:\n${lastReply ?? ""}`
      ].join("\n");
    case "failed":
      return [
        `[Thread notice] ${who}: its round failed.`,
        ...(notice.reason ? [notice.reason] : []),
        `Last reply:\n${lastReply ?? ""}`
      ].join("\n");
    default:
      return `[Thread notice] ${who}: reports.\nReport:\n${lastReply ?? ""}`;
  }
}

function chatOf(raw: unknown): NonNullable<ThreadNotice["chat"]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { from, to, messages } = raw as { from?: unknown; to?: unknown; messages?: unknown };
  if (typeof from !== "string" || typeof to !== "string" || typeof messages !== "number" || !Number.isInteger(messages) || messages < 1) return null;
  return { from, to, messages };
}

function questionOf(raw: unknown): NonNullable<ThreadNotice["question"]> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, text, options } = raw as { id?: unknown; text?: unknown; options?: unknown };
  if (typeof id !== "string" || !id || typeof text !== "string" || !text) return null;
  return { id, text, options: optionsOf(options) };
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

/** How the agent is shown a time: by default as stored (ISO). */
export interface ThreadNoticeFormat { time?: (at: string) => string }

/** The notice as the agent's model reads it. `lastReply` is already cut. */
export function formatThreadNoticeText(notice: ThreadNotice, lastReply: string | null, format: ThreadNoticeFormat = {}): string {
  return withTasks(formatThreadNoticeBody(notice, lastReply, format), notice.tasks);
}

/** The user's direct chat with a thread, gone quiet, in fixed wording the
 *  personal agent reads. */
function formatChatNotice(notice: ThreadNotice, chat: NonNullable<ThreadNotice["chat"]>, lastReply: string | null, format: ThreadNoticeFormat): string {
  const time = format.time ?? ((at: string) => at);
  const count = `${chat.messages} ${chat.messages === 1 ? "message" : "messages"}`;
  return [
    `[Thread notice] Thread "${notice.title}" (${notice.targetThreadId ?? "unknown"}): the user talked with it directly from ${time(chat.from)} to ${time(chat.to)} (${count}) and has seen its replies; you were not told of these rounds as they happened. Keep what it changed, as on your page and the tasks. Tell the user only what still needs them; otherwise no reply is needed.`,
    `The user said:\n${notice.words ?? ""}`,
    ...(lastReply ? [`Its latest reply:\n${lastReply}`] : []),
    ...(notice.verdict === "decision" ? [VERDICT_LINE.decision] : [])
  ].join("\n");
}

function formatThreadNoticeBody(notice: ThreadNotice, lastReply: string | null, format: ThreadNoticeFormat): string {
  if (notice.duty) return formatDutyNotice(notice, lastReply);
  if (notice.stop === "chat" && notice.chat) return formatChatNotice(notice, notice.chat, lastReply, format);
  const who = notice.kind === "worker"
    ? `Worker ${notice.title} (${notice.workerId ?? "unknown"})`
    : `Thread "${notice.title}" (${notice.targetThreadId ?? "unknown"})`;
  if (notice.stop === "asked" && notice.question) {
    const { id, text, options } = notice.question;
    return [
      `[Thread notice] ${who}: asked the user a question.`,
      // The id is what send_to_thread's `answers` names it by.
      `Question (${id}): ${text}`,
      ...(options.length > 0
        ? ["Suggested answers:", ...options.map((option, index) => `${index + 1}. ${option.label}${option.description ? `: ${option.description}` : ""}`)]
        : []),
      // In a round the personal agent started its prompt says what to do: answer the
      // user's way when they decided this before, else ask them.
      ...(notice.noWait ? [] : ["The thread goes on working, and so does your wait on it."]),
      ...(notice.direct ? [OWN_ROUND_QUESTION_LINE] : notice.noWait ? [NO_WAIT_QUESTION_LINE] : [])
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
  if (notice.direct && notice.stop === "needs_you") lines.push(OWN_ROUND_QUESTION_LINE);
  else if (notice.after) lines.push(AFTER_LINE[left]);
  if (notice.reason) lines.push(notice.reason);
  lines.push(lastReply ? `Last reply:\n${lastReply}` : "It has said nothing since you began waiting.");
  return lines.join("\n");
}
