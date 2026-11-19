import type { AgentMessage } from "@/store/agent-chat";
import { ASK_TOOL, WITHDRAW_TOOL, answersOf, askedOf, skippedOf, withdrawnOf, type OpenQuestion } from "@shared/questions";
import type { ToolCallSpec, ToolResultSpec } from "./tool-run-summary";
import type { TranscriptItem } from "./transcript-rows";

/** A question in the conversation, where it was asked: read from the same
 *  rows by the same rule as what is open (shared/questions.ts). Pure, so
 *  which calls become lines is tested as data. */

/** `open`: it waits for the user. `answered`: it does not any more.
 *  `withdrawn`: its asker took it back. `skipped`: the user closed it
 *  without an answer. */
export type AskState = "open" | "answered" | "withdrawn" | "skipped";

/** What a reply row needs to say how each question it asked stands. */
export interface QuestionMarks {
  /** The conversation's open questions, by id. */
  open: ReadonlySet<string>;
  /** The questions its loaded rows took back. */
  withdrawn: ReadonlySet<string>;
  /** The questions its loaded rows say the user skipped. */
  skipped: ReadonlySet<string>;
  /** What the user answered each question with, by id: the words of their
   *  loaded message that names it. */
  answers?: ReadonlyMap<string, string>;
}

const ASK_OPEN_PREFIX = "ask:";

/** The key the transcript keeps a question's line open under. */
export function askOpenKey(questionId: string): string {
  return `${ASK_OPEN_PREFIX}${questionId}`;
}

/** Whether an answered question's line is open where it is drawn: then it
 *  holds the reader's place, as an open fold does, so a long question growing
 *  in is not pushed off the top by following the end. Read from the rows
 *  drawn, never from the marks alone: a mark can outlive its line. */
export function openAskPausesFollow(
  rows: readonly TranscriptItem[],
  results: ReadonlyMap<string, ToolResultSpec>,
  expandedIds: ReadonlySet<string>,
  open: ReadonlySet<string>
): boolean {
  if (![...expandedIds].some((id) => id.startsWith(ASK_OPEN_PREFIX))) return false;
  for (const item of rows) {
    if (item.kind !== "msg") continue;
    for (const step of [item.message, ...(item.runTail ?? [])]) {
      if (step.content.type !== "assistant") continue;
      for (const call of (step.content.toolCalls ?? []) as ToolCallSpec[]) {
        const asked = askedBy(call, results.get(call.toolCallId));
        if (asked && !open.has(asked.id) && expandedIds.has(askOpenKey(asked.id))) return true;
      }
    }
  }
  return false;
}

/** What the user answered each question with: the words of each of their
 *  messages, for every question it names. */
export function answeredQuestions(messages: readonly AgentMessage[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "user" || message.content.type !== "text") continue;
    for (const { id } of answersOf(message.content)) answers.set(id, message.content.text);
  }
  return answers;
}

/** The question a call asked: only what the ask tool accepted. A call that
 *  was refused, or is still on its way, asked nothing yet and stays a call. */
export function askedBy(call: ToolCallSpec, result: ToolResultSpec | null | undefined): OpenQuestion | null {
  if (call.toolName !== ASK_TOOL || !result) return null;
  return askedOf(
    { type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, result: result.result, isError: result.isError },
    result.createdAt ?? ""
  );
}

/** The question a call took back: only a withdrawal that went through. */
export function withdrawnBy(call: ToolCallSpec, result: ToolResultSpec | null | undefined): string | null {
  if (call.toolName !== WITHDRAW_TOOL || !result) return null;
  return withdrawnOf({ type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName, result: result.result, isError: result.isError });
}

/** Where the open questions are not known, a question reads as answered. */
export function askState(questionId: string, marks: QuestionMarks | undefined): AskState {
  if (marks?.withdrawn.has(questionId)) return "withdrawn";
  if (marks?.open.has(questionId)) return "open";
  return marks?.skipped.has(questionId) ? "skipped" : "answered";
}

/** The questions a conversation's loaded rows say the user skipped. A skip
 *  comes after its question, so one whose question is loaded is loaded too. */
export function skippedQuestions(messages: readonly AgentMessage[]): Set<string> {
  return new Set(messages.flatMap((message) => skippedOf(message)));
}

/** The questions a conversation's loaded rows took back. A withdrawal comes
 *  after its question, so one whose question is loaded is loaded too. */
export function withdrawnQuestions(messages: readonly AgentMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const id = message.role === "tool" ? withdrawnOf(message.content) : null;
    if (id) ids.add(id);
  }
  return ids;
}
