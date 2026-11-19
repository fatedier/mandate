import type { AgentMessage } from "../agent/agent-store.js";
import { estimateTextTokens } from "../agent/compression.js";
import { isToolImageResultContent } from "../agent/wake-message-adapter.js";
import { isModelOnlySource } from "../../../shared/agent-message-types.js";

/** The most the opening may take, in tokens (estimated as compaction does). */
export const REVIEW_OPENING_BUDGET_TOKENS = 40_000;
/** The most of one tool result (and of one call's arguments) the opening shows. */
export const OPENING_RESULT_CHARS = 2_000;
/** The most of one tool result `read_transcript` shows, and of one page. */
export const TRANSCRIPT_RESULT_CHARS = 20_000;
export const TRANSCRIPT_PAGE_CHARS = 60_000;
/** The most of one message's own text (the user's, an agent's) either shows:
 *  a pasted log or document is read in part, never past a page or the
 *  opening's budget. */
export const MESSAGE_TEXT_CHARS = 20_000;

/** How a cut part says what is left: in the opening, read_transcript shows
 *  more of a result; past what read_transcript shows, nothing does. */
const MORE_IN_TRANSCRIPT = (n: string) => `… ${n} more characters; read_transcript shows more.`;
const MORE_CUT = (n: string) => `… ${n} more characters cut.`;

interface RenderLimits {
  /** A tool result's. */
  resultChars: number;
  resultNote: (n: string) => string;
  /** Each call's arguments, by what the step's other words take (its own
   *  text, each call's header and room for its cut note) and how many calls
   *  share the rest; and what a cut says. */
  argChars: (step: StepShape) => number;
  argNote: (step: StepShape) => (n: string) => string;
}

/** What a step's lines take besides its calls' arguments, and how many calls it made. */
interface StepShape { calls: number; overhead: number }

/** The longest cut note, a line break included: what each call keeps room for. */
const NOTE_ROOM = `\n${MORE_CUT("999,999,999")}`.length;

/** How much of each call's arguments read_transcript shows: the calls of
 *  one step share what its page has left after the step's other words, so a
 *  step is always read whole on one page and nothing promised is cut away. */
export function transcriptArgChars(step: StepShape, pageChars = TRANSCRIPT_PAGE_CHARS, resultChars = TRANSCRIPT_RESULT_CHARS): number {
  return Math.max(0, Math.min(resultChars, Math.floor((pageChars - step.overhead) / Math.max(1, step.calls))));
}

/** The opening's limits: a result's first part, more of it in the
 *  transcript; a call's first part, and "more" only where the transcript
 *  shows more of it. */
const OPENING_LIMITS: RenderLimits = {
  resultChars: OPENING_RESULT_CHARS,
  resultNote: MORE_IN_TRANSCRIPT,
  argChars: () => OPENING_RESULT_CHARS,
  argNote: (step) => (transcriptArgChars(step) > OPENING_RESULT_CHARS ? MORE_IN_TRANSCRIPT : MORE_CUT)
};

export interface ReviewSkillLine {
  name: string;
  description: string;
  /** "global" or "project {name}". */
  where: string;
  status: string;
  revision: number;
  uses90: number;
  lastUsedAt: string | null;
}

export interface ReviewOpeningInput {
  conversation: { threadId: string; title: string; kind: "worker" | "manager" | "personal"; workerName?: string; projectNames: string[] };
  /** The requesting conversation, as its title reads. */
  requestedBy: string;
  focus: string;
  fromSeq: number;
  toSeq: number;
  /** The range's messages, in order. */
  messages: readonly AgentMessage[];
  /** The subagents started in the conversation: their threads are part of the work. */
  subagents: ReadonlyArray<{ threadId: string; title: string }>;
  /** The skills the review may change. */
  skills: readonly ReviewSkillLine[];
  budgetTokens?: number;
}

/** One message as a review reads it: its full line (results cut to
 *  `resultChars`) and its one-line form. Null for what is not the work (the
 *  model's own context rows, summaries, failures). */
function renderMessage(message: AgentMessage, limits: RenderLimits): { full: string; short: string } | null {
  const result = (text: string) => cut(text, limits.resultChars, limits.resultNote);
  const own = (text: string) => cut(text, MESSAGE_TEXT_CHARS, MORE_CUT);
  if (message.role === "system" || isModelOnlySource(message.source)) return null;
  const at = `#${message.seq}`;
  const content = message.content;
  switch (content.type) {
    case "text": {
      const text = content.text.trim();
      if (!text) return null;
      const who = message.role === "user" && (message.source === "user" || message.source === "voice") ? "user" : message.role === "assistant" ? "agent" : message.source;
      return { full: `${at} ${who}: ${own(text)}`, short: `${at} ${who}: ${oneLine(text)}` };
    }
    case "assistant": {
      const text = content.text?.trim() ?? "";
      const calls = content.toolCalls ?? [];
      const textLines = text ? [`${at} agent: ${own(text)}`] : [];
      const heads = calls.map((c) => `${at} agent called ${c.toolName} `);
      // As the transcript renders the step: its text, each call's header and
      // note room, and a line break after every line but the last.
      const step: StepShape = {
        calls: calls.length,
        overhead: [...textLines.map((line) => line.length), ...heads.map((head) => head.length + NOTE_ROOM)].reduce((n, len) => n + len + 1, 0)
      };
      const full = [
        ...textLines,
        ...calls.map((c, i) => `${heads[i]}${cut(JSON.stringify(c.args ?? null), limits.argChars(step), limits.argNote(step))}`)
      ];
      if (full.length === 0) return null;
      const short = calls.length > 0 ? `${at} agent called ${calls.map((c) => c.toolName).join(", ")}` : `${at} agent: ${oneLine(text)}`;
      return { full: full.join("\n"), short };
    }
    case "tool_result": {
      const text = content.isError
        ? `error: ${content.error ?? "unknown"}`
        : isToolImageResultContent(content.result) ? content.result.message : typeof content.result === "string" ? content.result : JSON.stringify(content.result ?? null);
      return { full: `${at} result of ${content.toolName}: ${result(text)}`, short: `${at} result of ${content.toolName}: ${content.isError ? "error" : "ok"}` };
    }
    case "summary":
    case "wake_failure":
      return null;
  }
}

function cut(text: string, max: number, note: (n: string) => string): string {
  if (text.length <= max) return text;
  // Not between the two halves of one character.
  const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
  return `${text.slice(0, end)}\n${note((text.length - end).toLocaleString("en-US"))}`;
}

function oneLine(text: string): string {
  const first = text.split("\n", 1)[0]!;
  return first.length > 120 || first.length < text.length ? `${first.slice(0, 120)}…` : first;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function kindText(c: ReviewOpeningInput["conversation"]): string {
  if (c.kind === "worker") return `worker ${c.workerName ?? c.title}${c.projectNames[0] ? ` in project ${c.projectNames[0]}` : ""}`;
  if (c.kind === "manager") return `a manager thread${c.projectNames.length ? `; its workers' projects: ${c.projectNames.join(", ")}` : ""}`;
  return "the personal agent's thread";
}

function skillLine(s: ReviewSkillLine): string {
  const used = s.lastUsedAt ? `last used ${s.lastUsedAt.slice(0, 10)}` : "never used";
  return `- ${s.name} (${s.where}, ${s.status}, revision ${s.revision}; ${plural(s.uses90, "use", "uses")} in 90 days, ${used}): ${s.description}`;
}

/**
 * The one message a review starts from: who asked and what to keep, the
 * conversation and its range, the range's messages, and the skills it may
 * change. Past the budget, the turns after the first are one line each from
 * the oldest on, the last ones kept whole, and it says which; if one line
 * each is still too much, the oldest of those are left out.
 */
export function renderReviewOpening(input: ReviewOpeningInput): string {
  const budget = input.budgetTokens ?? REVIEW_OPENING_BUDGET_TOKENS;
  const c = input.conversation;
  const head = [
    `A review of finished work, requested by ${input.requestedBy}.`,
    `What to keep: ${input.focus}`,
    "",
    `The conversation: ${c.title} (${kindText(c)}), thread ${c.threadId}. Messages ${input.fromSeq} to ${input.toSeq} follow; read_transcript reads any part of it, earlier messages too.`,
    ...(input.subagents.length
      ? ["Subagents it started, whose threads read_transcript reads too:", ...input.subagents.map((s) => `- ${s.title}: thread ${s.threadId}`)]
      : [])
  ];
  const tail = input.skills.length ? ["Learned skills you may change:", ...input.skills.map(skillLine)] : ["Learned skills you may change: none yet."];
  const rows = input.messages.flatMap((m) => {
    const r = renderMessage(m, OPENING_LIMITS);
    return r ? [{ seq: m.seq, ...r }] : [];
  });
  // The note on what was shortened is written once the lines are chosen; its room is kept now.
  const fixed = estimateTextTokens([...head, "", "", ...tail].join("\n")) + estimateTextTokens("Shortened: messages 000000 to 000000 are one line each here; messages 000000 to 000000 are left out.");
  const room = budget - fixed;
  const cost = (line: string) => estimateTextTokens(line) + 1;
  const lines = rows.map((r) => r.full);
  let note: string | null = null;
  if (rows.reduce((sum, r) => sum + cost(r.full), 0) > room && rows.length > 1) {
    // The request (the first row) whole; the rest one line each, then the
    // newest made whole again while they fit.
    lines.splice(0, lines.length, rows[0]!.full, ...rows.slice(1).map((r) => r.short));
    let used = lines.reduce((sum, line) => sum + cost(line), 0);
    let whole = rows.length;
    while (whole - 1 > 1) {
      const i = whole - 1;
      const grown = used - cost(rows[i]!.short) + cost(rows[i]!.full);
      if (grown > room) break;
      lines[i] = rows[i]!.full;
      used = grown;
      whole = i;
    }
    // Still too much: the oldest one-line rows go.
    let dropped = 0;
    while (used > room && 1 + dropped < whole) {
      used -= cost(lines[1 + dropped]!);
      dropped += 1;
    }
    const shortFrom = 1 + dropped;
    const parts: string[] = [];
    if (shortFrom < whole) parts.push(`messages ${rows[shortFrom]!.seq} to ${rows[whole - 1]!.seq} are one line each here`);
    if (dropped > 0) parts.push(`messages ${rows[1]!.seq} to ${rows[dropped]!.seq} are left out`);
    if (parts.length) note = `Shortened: ${parts.join("; ")}.`;
    lines.splice(1, dropped);
  }
  return [...head, ...(note ? [note] : []), "", ...lines, "", ...tail].join("\n");
}

/** A page of a conversation for `read_transcript`: whole messages, results
 *  cut to `resultChars`, until the page holds `pageChars` (one message at
 *  least); `nextSeq` is where the next page starts, null at the end. */
export function renderTranscript(messages: readonly AgentMessage[], opts: { resultChars: number; pageChars: number }): { text: string; nextSeq: number | null } {
  const out: string[] = [];
  let size = 0;
  for (const m of messages) {
    const r = renderMessage(m, {
      resultChars: opts.resultChars,
      resultNote: MORE_CUT,
      argChars: (step) => transcriptArgChars(step, opts.pageChars, opts.resultChars),
      argNote: () => MORE_CUT
    });
    if (!r) continue;
    if (out.length > 0 && size + r.full.length > opts.pageChars) return { text: out.join("\n"), nextSeq: m.seq };
    // A page's first message is shown even when it alone fills more than a
    // page (many calls with long arguments): cut to the page, never past it.
    const line = r.full.length > opts.pageChars ? cut(r.full, opts.pageChars - 100, MORE_CUT) : r.full;
    out.push(line);
    size += line.length + 1;
  }
  return { text: out.join("\n"), nextSeq: null };
}
