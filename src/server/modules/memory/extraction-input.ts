import type { AgentMessage } from "../agent/agent-store.js";
import { estimateTextTokens } from "../agent/compression.js";
import { isToolImageResultContent } from "../agent/wake-message-adapter.js";
import type { UserStatement } from "./user-quote.js";
import { isModelOnlySource } from "../../../shared/agent-message-types.js";

/** The most of one tool result the extraction model reads. */
export const TOOL_RESULT_TOKEN_LIMIT = 2_000;

/** The messages leaving a model's context, as the extraction model reads them:
 *  the user's words whole, assistant text with the tools it called, tool
 *  results cut to TOOL_RESULT_TOKEN_LIMIT, each day's part headed by its
 *  date (UTC), for absolute dates. Past `budgetTokens` the middle goes and
 *  the start and end stay. */
export function renderWindowForExtraction(messages: readonly AgentMessage[], budgetTokens: number): string {
  const rows = messages.flatMap((message) => {
    const line = renderMessage(message);
    return line === null ? [] : [{ line, day: message.createdAt.slice(0, 10) }];
  });
  return fitToBudget(rows, budgetTokens);
}

/** Whether the extraction model reads this row: not a context snapshot, a
 *  summary or the prompt. */
export function isConversationRow(message: AgentMessage): boolean {
  return renderMessage(message) !== null;
}

/** What the user wrote or said in these messages: what a quote is checked
 *  against. What their agent sent for them carries its words, not theirs. */
export function userStatementsOf(messages: readonly AgentMessage[]): Array<UserStatement & { id: string }> {
  return userMessagesOf(messages)
    .filter((m) => !m.relayed)
    .map(({ text, at, id }) => ({ text, at, id }));
}

/** The first message from the user, or sent for them by their agent: what an
 *  unquoted memory rests on. */
export function firstUserMessageId(messages: readonly AgentMessage[]): string | null {
  return userMessagesOf(messages)[0]?.id ?? null;
}

function userMessagesOf(messages: readonly AgentMessage[]): Array<UserStatement & { id: string; relayed: boolean }> {
  return messages.flatMap((m) => {
    if (m.role !== "user" || (m.source !== "user" && m.source !== "voice") || m.content.type !== "text") return [];
    if (!m.content.text.trim()) return [];
    return [{ text: m.content.text, at: m.createdAt, id: m.id, relayed: Boolean(m.content.relay) }];
  });
}

function renderMessage(message: AgentMessage): string | null {
  // What the model alone was handed is not the conversation (a compression
  // summary is skipped by its content type below).
  if (message.role === "system" || isModelOnlySource(message.source)) return null;
  const content = message.content;
  switch (content.type) {
    case "text": {
      const text = content.text.trim();
      if (!text) return null;
      const who = message.role === "user" && (message.source === "user" || message.source === "voice")
        ? "user"
        : `${message.role}/${message.source}`;
      return `[${who}] ${text}`;
    }
    case "assistant": {
      const parts = [content.text?.trim() ?? "", ...(content.toolCalls ?? []).map((call) => `(called ${call.toolName})`)];
      const text = parts.filter(Boolean).join(" ");
      return text ? `[assistant] ${text}` : null;
    }
    case "tool_result":
      return `[tool ${content.toolName}] ${capTokens(toolResultText(content), TOOL_RESULT_TOKEN_LIMIT)}`;
    case "summary":
    case "wake_failure":
      return null;
  }
}

function toolResultText(content: Extract<AgentMessage["content"], { type: "tool_result" }>): string {
  if (content.isError) return `error: ${content.error ?? "unknown"}`;
  if (isToolImageResultContent(content.result)) return content.result.message;
  return typeof content.result === "string" ? content.result : JSON.stringify(content.result ?? null);
}

function capTokens(text: string, limit: number): string {
  if (estimateTextTokens(text) <= limit) return text;
  let end = Math.min(text.length, limit * 4);
  while (end > 0 && estimateTextTokens(text.slice(0, end)) > limit) end = Math.floor(end * 0.8);
  return `${text.slice(0, end)} … [cut]`;
}

/** Keeps a run from the start and a run from the end, taking a turn from
 *  each side in turn while it fits. A turn over half the budget keeps its
 *  start and its end, so the first and the last turn always fit together. */
function capMiddle(text: string, limit: number): string {
  if (estimateTextTokens(text) <= limit) return text;
  const excerpt = (keep: number) =>
    `${text.slice(0, Math.ceil(keep / 2))} … [cut] … ${text.slice(text.length - Math.floor(keep / 2))}`;
  let keep = Math.min(text.length, limit * 4);
  while (keep > 0 && estimateTextTokens(excerpt(keep)) > limit) keep = Math.floor(keep * 0.8);
  return excerpt(keep);
}

/** What one `--- YYYY-MM-DD ---` line costs. */
const DAY_LINE_TOKENS = estimateTextTokens("--- 0000-00-00 ---");

function fitToBudget(rows: Array<{ line: string; day: string }>, budgetTokens: number): string {
  const whole = rows.map((row) => row.line);
  const days = rows.map((row) => row.day);
  // A day line goes before a row whose day is not the row before it's.
  const opensDay = (i: number) => i === 0 || days[i] !== days[i - 1];
  const wholeTotal = whole.reduce((sum, line, i) => sum + estimateTextTokens(line) + (opensDay(i) ? DAY_LINE_TOKENS : 0), 0);
  if (wholeTotal <= budgetTokens) return withDays(rows);
  // Half the budget less a day line each: the first and the last row, under
  // their day lines, always fit together.
  const lines = whole.map((line) => capMiddle(line, Math.floor(budgetTokens / 2) - DAY_LINE_TOKENS));
  const sizes = lines.map(estimateTextTokens);
  // The head grows forward from the first row; the tail backward from the
  // last, its first row always under a day line (after the cut): a row put in
  // front of it takes that line, and the old first keeps one only for a day
  // of its own.
  const headCost = (i: number) => sizes[i]! + (opensDay(i) ? DAY_LINE_TOKENS : 0);
  const tailCost = (start: number) => {
    const i = start - 1;
    const freed = start < lines.length && days[start] === days[i] ? DAY_LINE_TOKENS : 0;
    return sizes[i]! + DAY_LINE_TOKENS - freed;
  };
  let head = 0;
  let tail = lines.length;
  let used = 0;
  let fromHead = true;
  while (head < tail) {
    const headFits = used + headCost(head) <= budgetTokens;
    const tailFits = used + tailCost(tail) <= budgetTokens;
    if (!headFits && !tailFits) break;
    if (headFits && (fromHead || !tailFits)) {
      used += headCost(head);
      head += 1;
    } else {
      used += tailCost(tail);
      tail -= 1;
    }
    fromHead = !fromHead;
  }
  const kept = (from: number, to: number) => rows.slice(from, to).map((row, i) => ({ line: lines[from + i]!, day: row.day }));
  return [
    withDays(kept(0, head)),
    ...(tail > head ? [`[… ${tail - head} messages omitted …]`] : []),
    withDays(kept(tail, lines.length))
  ].filter((part) => part.length > 0).join("\n");
}

/** The lines with a `--- YYYY-MM-DD ---` line wherever the day changes,
 *  and before the first. */
function withDays(rows: Array<{ line: string; day: string }>): string {
  const out: string[] = [];
  let day = "";
  for (const row of rows) {
    if (row.day !== day) out.push(`--- ${row.day} ---`);
    day = row.day;
    out.push(row.line);
  }
  return out.join("\n");
}
