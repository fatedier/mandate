import type { ActivityCacheKind, CacheSealPauseDto, CacheVerdictDto, JudgementNotUsed, JudgementSubjectDto, LlmCallLedgerDto } from "@shared/api-contracts";
import { formatCalendarDate, formatClockMinutes, formatDuration } from "@/lib/format";
import { formatUsd } from "./money";

/**
 * Every word the Activity ledger shows, in one place: the names of roles,
 * wakes and verdicts, and the sentences built from the ledger's figures.
 */

export const LEDGER_COPY = {
  spend: "Spend",
  byAgent: "By agent",
  byAgentMeta: "who spent it",
  cache: "Cache",
  cacheMeta: "prompts paid for again",
  tokens: "What the spend is made of",
  wakes: "What woke the agents",
  wakesMeta: "agent turns, by why they ran",
  openLogs: "Open logs",
  showCalls: "Show these calls",
  legendExpired: "Cache expired: paid on top of a cache read",
  legendRest: "Everything else",
  cacheEmpty: "No call paid for its prompt again.",
  timer: "timer",
  underOneDollar: "under $1",
  reportedUnsplit: "Reported, not split",
  previousDay: "Previous day",
  nextDay: "Next day"
} as const;

/** A picked day's place in the window, beside the Spend title. */
export function oneDayOf(window: string): string {
  return `one day of the last ${window}`;
}

/** What the picked day's chip clears to. */
export function showAll(window: string): string {
  return `Show all ${window}`;
}

export const AGENT_HEADS = { agent: "Agent", calls: "Calls", spend: "Spend", share: "Share", expired: "Cache expired" } as const;
export const CACHE_HEADS = { verdict: "Verdict", calls: "Calls", extra: "Extra" } as const;
export const WAKE_HEADS = { why: "Why", who: "Who", runs: "Runs", perRun: "Per run", spend: "Spend", expired: "Of it, cache expired", expiredNarrow: "Expired" } as const;
export const TOKEN_LABELS = { cacheWrite: "Cache write", cacheRead: "Cache read", output: "Output", uncachedInput: "Uncached input" } as const;

const own = (table: Record<string, string>, key: string): string | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

const ROLE_LABELS: Record<string, string> = {
  your_agent: "Your agent",
  managers: "Managers",
  workers: "Workers",
  your_agents_page: "Your agent's page",
  subagents: "Subagents",
  dream: "Dream",
  compaction: "Compaction",
  cache_seal: "Cache seal",
  memory_extraction: "Memory extraction",
  memory_repeat_check: "Memory repeat check",
  manager_request_check: "Manager request check",
  manager_stop_check: "Manager stop check",
  web_search: "Web search",
  deleted_thread: "Deleted thread"
};

const PURPOSE_ROLE_PREFIX = "purpose:";

/** A role's name; a bare purpose (`purpose:<id>`) shows its id. */
export function roleLabel(key: string): string {
  return own(ROLE_LABELS, key) ?? (key.startsWith(PURPOSE_ROLE_PREFIX) ? key.slice(PURPOSE_ROLE_PREFIX.length) : key);
}

const WAKE_LABELS: Record<string, string> = {
  messages: "Messages",
  worker_reports: "Worker reports",
  thread_notices: "Thread notices",
  alarms: "Alarms",
  check_ins: "Check-ins",
  watches: "Watches and monitors",
  command_results: "Command results",
  subagent_tasks: "Subagent tasks",
  // The screen calls a worker a worker, and says no "work item": these two
  // take the names the chat's own cause lines use.
  dream: "Dream",
  manager_request_check: "Manager request check",
  manager_stop_check: "Manager stop check",
  unknown: "Unknown"
};

/** A wake group's name; a reason no group names shows itself. */
export function wakeLabel(key: string): string {
  return own(WAKE_LABELS, key) ?? key;
}

/** Roles as one phrase: "Your agent, managers, workers". Names after the
 *  first are lower-cased, except the ones that are names ("Your …"). */
export function whoList(roles: string[]): string {
  return roles
    .map((role, index) => {
      const label = roleLabel(role);
      return index === 0 || label.startsWith("Your") ? label : label.charAt(0).toLowerCase() + label.slice(1);
    })
    .join(", ");
}

export const VERDICT_LABELS: Record<ActivityCacheKind, string> = {
  expired: "Cache expired",
  miss: "Miss",
  not_reused: "Not reused",
  rebuild: "Expected rebuild"
};

/** Families as their makers write them; the rest are names. */
const FAMILY_NAMES: Record<string, string> = { gpt: "GPT", glm: "GLM", deepseek: "DeepSeek", minimax: "MiniMax" };
function familyLabel(family: string): string {
  // OpenAI's o-series is written in lower case (o3, o4-mini).
  if (/^o\d/.test(family)) return family;
  return own(FAMILY_NAMES, family) ?? family.charAt(0).toUpperCase() + family.slice(1);
}

export function verdictDescription(kind: ActivityCacheKind, topFamily: string | null): string {
  switch (kind) {
    case "expired": return "Claude, after more than 5 minutes idle";
    case "miss": return "Claude, within its 5 minutes";
    case "not_reused": return `models with no fixed cache time${topFamily ? `; mostly ${familyLabel(topFamily)}` : ""}`;
    case "rebuild": return "after a compaction, or a change of model or connection";
  }
}

/** The window as a word: the 24-hour, 7-day and 30-day windows read as a day,
 *  a week and a month. */
export function periodWord(days: number): string {
  return days === 1 ? "day" : days === 7 ? "week" : days === 30 ? "month" : "period";
}

/** The line under the cache rows. Without spend there is no share to give. */
export function cacheClosingLine(args: {
  sharePct: number | null;
  medianMinutes: number;
  withinHour: number;
  expired: number;
  wrote1h: boolean;
  periodWord: string;
}): string {
  const parts = [
    args.sharePct === null ? "" : `${args.sharePct}% of spend.`,
    `Half of these calls came ${args.medianMinutes} minutes or less after the one before, and ${args.withinHour.toLocaleString("en-US")} of the ${args.expired.toLocaleString("en-US")} within an hour, which a 1-hour cache would have kept.`,
    args.wrote1h ? "" : `No call this ${args.periodWord} wrote a 1-hour cache.`
  ];
  return parts.filter(Boolean).join(" ");
}

export function writeReadLine(ratio: number): string {
  return `On Claude a cache write costs ${Number.isInteger(ratio) ? ratio : ratio.toFixed(1)} times a cache read.`;
}

/** "2026-01-02" as "Jan 2". */
function monthDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function estimateFootnote(date: string): string {
  return `~ marks an estimate at list prices (LiteLLM and models.dev, ${monthDay(date)}), not a bill.`;
}

/** "the 7 days before"; one day reads as "the day before". */
export function previousPeriod(days: number): string {
  return days === 1 ? "the day before" : `the ${days} days before`;
}

/** The Logs presets, in order. */
export const PRESETS = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "slow", label: "Slow" },
  { id: "expired", label: "Cache expired" },
  { id: "timers", label: "Timers" }
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

export const PAID_ON_TOP = "paid on top of a cache read";

const SINGULAR: Record<string, string> = { managers: "Manager", workers: "Worker", subagents: "Subagent" };

/** Whether a call belongs to a thread: what its detail names it by. */
export function callInThread(ledger: LlmCallLedgerDto): boolean {
  return ledger.inThread;
}

/** A model id without the provider or gateway prefix before its last `/`,
 *  in one case and with a version's dots read as dashes (a vendor's
 *  MiniMax-M2.5 is a gateway's minimax-m2.5; claude-sonnet-4-6 is
 *  claude-sonnet-4.6). Other spellings read as another model: the sentence
 *  then names the previous id, still true. */
function modelName(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1).toLowerCase().replaceAll(".", "-");
}

/** Whose call it was, as a row says it: "Manager · <title>", "Your agent". */
export function threadLine(ledger: LlmCallLedgerDto): string {
  if (ledger.threadDeleted) return roleLabel("deleted_thread");
  const singular = own(SINGULAR, ledger.role);
  if (singular) return ledger.threadTitle ? `${singular} · ${ledger.threadTitle}` : singular;
  return roleLabel(ledger.role);
}

/** A row's third line: how long the thread sat, what woke it, what it cost on top. */
export function rowVerdictLine(verdict: CacheVerdictDto, wakeKey: string | null): string {
  return [
    `idle ${formatDuration(verdict.idleMs)} before`,
    wakeKey ? wakeLabel(wakeKey) : "",
    verdict.extraMicros !== null ? `${formatUsd(verdict.extraMicros, true)} extra` : ""
  ].filter(Boolean).join(" · ");
}

/** Why a paused model's cache seal stopped. */
const SEAL_PAUSE_REASONS: Record<CacheSealPauseDto["failure"], (pause: CacheSealPauseDto) => string> = {
  short_write: () => "the seal's cache was written for 5 minutes, not 1 hour.",
  not_read: () => "the next step did not read the sealed prompt.",
  prefix_changed: () => "the next step did not read the sealed prompt.",
  output: (pause) => `the seal produced ${pause.outputTokens ?? 0} output tokens, not 1.`,
  errors: () => "the seal request failed 3 times in a row."
};

/** A model whose cache seal is paused: until when, and why. A try already due waits for the model's next seal, so it
 *  names no time; a time on another day names its date. */
export function cacheSealPauseNote(pause: CacheSealPauseDto, nowMs: number = Date.now()): string {
  const reason = SEAL_PAUSE_REASONS[pause.failure](pause);
  const at = Date.parse(pause.nextTryAt);
  if (at <= nowMs) return `Cache seal paused for ${pause.model}, retrying with its next seal — ${reason}`;
  const today = new Date(at).toDateString() === new Date(nowMs).toDateString();
  const time = formatClockMinutes(pause.nextTryAt);
  return `Cache seal paused for ${pause.model} until ${today ? time : `${formatCalendarDate(pause.nextTryAt, nowMs)}, ${time}`} — ${reason}`;
}

/** The sentence in a call's detail that explains its verdict. */
export function verdictSentence(verdict: CacheVerdictDto, model: string | null): string {
  const idle = formatDuration(verdict.idleMs);
  // A cache's lifetime runs from the start of a call.
  const sinceStart = formatDuration(verdict.sinceStartMs);
  const tokens = verdict.rewrittenTokens.toLocaleString("en-US");
  switch (verdict.kind) {
    case "expired": {
      const lifetime = verdict.lifetimeMs !== null && verdict.lifetimeMs >= 3_600_000 ? "1 hour" : "5 minutes";
      const cost = verdict.extraMicros !== null ? `: ${formatUsd(verdict.extraMicros, true)} more than reading them.` : ".";
      // Asked for an hour, kept for five minutes: the gap the reader can close.
      const shortened = verdict.requestedLifetimeMs === 3_600_000 && verdict.writtenLifetimeMs === 300_000
        ? " Mandate asked for a 1-hour cache; the provider wrote it for 5 minutes."
        : "";
      return `This thread's previous call started ${sinceStart} before this one, and Claude keeps a cache for ${lifetime} from the start of a call. ${tokens} tokens were written to the cache again instead of read${cost}${shortened}`;
    }
    case "miss":
      return `This thread's previous call started ${sinceStart} before this one, within the cache's lifetime, but ${tokens} tokens of its prompt were not read from the cache.`;
    case "not_reused":
      return `This thread's previous call ended ${idle} before this one. ${model ?? "This model"} keeps no fixed cache time, and ${tokens} tokens of its prompt were not read from the cache.`;
    case "rebuild":
      if (verdict.rebuildCause !== "model") return "The thread was compacted just before this call, so its prompt was new and written to the cache.";
      // The same model through another connection keeps no cache across them
      // either; a gateway's prefixed id and a provider's bare one name it alike.
      return verdict.previousModel !== null && model !== null && modelName(verdict.previousModel) === modelName(model)
        ? "The thread's previous call went through another connection, so this one had no cache to read."
        : `The thread's previous call ran on ${verdict.previousModel ?? "another model"}, so this model had no cache to read.`;
  }
}

// ---- Judgements (manager request check, manager stop check, memory repeat check) ----

/** The card's words. */
export const JUDGEMENT_COPY = { title: "Answer", choices: "Choices" } as const;

/** A judgement's choices as the screen names them; the model's own words
 *  (done, cannot, …) stay in its prompt. */
const ANSWER_LABELS: Record<string, string> = {
  done: "Done",
  cannot: "Can't go on",
  working: "Still working",
  decision: "Needs a decision",
  result: "Has a result",
  nothing: "Nothing for you",
  repeat: "Already stored",
  new: "New"
};

/** What each answer means, as its prompt defines it. */
const ANSWER_MEANINGS: Record<string, string> = {
  done: "The reply reports the request's work as finished.",
  cannot: "The reply says the work cannot go on, or waits for the user's answer or decision.",
  working: "The work goes on, or the reply is about other work.",
  decision: "The reply cannot go further until the user chooses, approves or answers something.",
  result: "The reply hands the user finished work they asked for.",
  nothing: "The reply leaves the user nothing to decide or read.",
  repeat: "A stored memory already says what it says, so it was not stored.",
  new: "It says something no stored memory says, so it was stored."
};

const NOT_USED_LINES: Record<JudgementNotUsed, string> = {
  stopped: "Not used: the thread stopped first, and its stop ended the wait.",
  newer_reply: "Not used: a newer reply came first.",
  question_open: "Not used: the thread waits for the user's answer.",
  newer_verdict: "Not used: a newer reply's answer is kept.",
  archived: "Not used: the thread was archived.",
  memory_changed: "Not used: a memory it was read beside changed meanwhile, so it was stored."
};

/** A choice's name; one no copy knows shows itself. */
export function answerLabel(option: string): string {
  return own(ANSWER_LABELS, option) ?? option;
}

export function answerMeaning(option: string): string | null {
  return own(ANSWER_MEANINGS, option) ?? null;
}

export function notUsedLine(reason: JudgementNotUsed): string {
  return NOT_USED_LINES[reason];
}

/** What a judgement was about: "About the reply at 14:05 to the request sent
 *  at 13:50" (a time on another day than today carries its date), or the
 *  memory a memory repeat check read and how many stored ones beside it. */
export function aboutLine(subject: JudgementSubjectDto, nowMs: number): string {
  if ("memory" in subject) {
    const n = subject.similar.length;
    return `About the memory “${subject.memory}”, read beside ${n} stored ${n === 1 ? "memory" : "memories"}`;
  }
  const reply = `About the reply at ${dayAndTime(subject.replyAt, nowMs)}`;
  return subject.requestAt ? `${reply} to the request sent at ${dayAndTime(subject.requestAt, nowMs)}` : reply;
}

function dayAndTime(at: string, nowMs: number): string {
  const today = new Date(Date.parse(at)).toDateString() === new Date(nowMs).toDateString();
  return today ? formatClockMinutes(at) : `${formatCalendarDate(at, nowMs)} ${formatClockMinutes(at)}`;
}
