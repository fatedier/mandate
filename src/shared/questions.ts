import type { AgentMessageDto } from "./api/agents.js";
import type { AgentMessageContent } from "./agent-message-types.js";

/** The questions a manager or the global agent asks the user, read from the
 *  conversation they are asked in. Nothing else records them: a question is
 *  open from the row that asked it until a row answers it or takes it back.
 *  Only a message that names the question it answers does: a pick, an answer
 *  typed in the question, the agent's answer for the user. Words that name
 *  none may be about something else, and only the asker can tell; it takes
 *  the question back if they made it moot.
 *  Pure, so the rule is tested as data and the page and the server agree. */

export const ASK_TOOL = "ask_user";
export const WITHDRAW_TOOL = "withdraw_question";
export const QUESTION_MAX_CHARS = 2000;
export const OPTION_LABEL_MAX_CHARS = 80;
export const OPTION_DESCRIPTION_MAX_CHARS = 200;

export interface QuestionOption { label: string; description?: string }

/** A question asked and not yet answered or taken back. */
export interface OpenQuestion {
  id: string;
  question: string;
  /** Suggested answers, the recommended one first; none for an open question. */
  options: QuestionOption[];
  askedAt: string;
}

/** What a pick says it answers, kept on the user's message. */
export interface AnsweredQuestion { id: string; question: string }

/** How a question closed in its own conversation: the user answered it
 *  there (their words), skipped it, or its asker took it back. */
export type QuestionSettlement = { how: "answered"; answer: string } | { how: "skipped" } | { how: "withdrawn" };

/** A row of a conversation, as the rule reads it. */
export type QuestionRow = Pick<AgentMessageDto, "role" | "source" | "content" | "createdAt">;

/** A message of the user's accepted but not yet a row: it waits behind a
 *  running turn. It answers the questions it names, none if it was typed. */
export interface QueuedAnswer { answers: readonly AnsweredQuestion[]; openWhenWritten?: readonly string[] }

const ANSWERS_KEY = "answers";
const OPEN_WHEN_WRITTEN_KEY = "openWhenWritten";
const CLOSED_KEY = "closedQuestions";
const CONTROL_KEY = "control";

/** The mark on a message that waited behind its conversation's running turn
 *  before it landed: the questions that stood when the user wrote it. The
 *  turn may have asked another since, and that one was never in front of
 *  them. A message with no such mark landed as it was written. */
export function openWhenWrittenMetadata(questionIds: readonly string[]): Record<string, unknown> {
  return { [OPEN_WHEN_WRITTEN_KEY]: [...questionIds] };
}

function openWhenWrittenOf(content: AgentMessageContent): Set<string> | null {
  const raw = content.type === "text" ? content.metadata?.[OPEN_WHEN_WRITTEN_KEY] : undefined;
  // Only a list of ids is the mark: anything else is no word of what stood.
  return Array.isArray(raw) && raw.every((id): id is string => typeof id === "string") ? new Set(raw) : null;
}

const WRITTEN_BEFORE_KEY = "writtenBefore";

/** The questions a message that waited does not answer though it landed
 *  after them: asked since it was written. Kept on the message for whoever
 *  asked, who reads the user's earlier words right after its question. */
export function writtenBeforeOf(content: AgentMessageContent): AnsweredQuestion[] {
  const raw = content.type === "text" ? content.metadata?.[WRITTEN_BEFORE_KEY] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, question } = entry as { id?: unknown; question?: unknown };
    return typeof id === "string" && id ? [{ id, question: typeof question === "string" ? question : "" }] : [];
  });
}

/** The content of a message that waited, as it lands: marked with the
 *  questions asked since it was written (`askedSince`, given those that
 *  stood then), when there are any. A message that carries no word of what
 *  stood did not wait, and is unchanged. */
export function landedAfterWaiting(
  content: AgentMessageContent,
  askedSince: (stood: ReadonlySet<string>) => readonly AnsweredQuestion[]
): AgentMessageContent {
  const stood = openWhenWrittenOf(content);
  if (content.type !== "text" || stood === null) return content;
  const since = askedSince(stood);
  if (since.length === 0) return content;
  return { ...content, metadata: { ...content.metadata, [WRITTEN_BEFORE_KEY]: since.map((q) => ({ id: q.id, question: q.question })) } };
}

/** The mark on a message a control sent for the user (Continue under a turn
 *  that stopped): theirs, but not their words about anything asked. */
export function controlMetadata(control: "continue"): Record<string, unknown> {
  return { [CONTROL_KEY]: control };
}

function sentByControl(content: AgentMessageContent): boolean {
  return content.type === "text" && content.metadata?.[CONTROL_KEY] === "continue";
}

export function answersMetadata(answers: readonly AnsweredQuestion[]): Record<string, unknown> {
  return { [ANSWERS_KEY]: answers.map((a) => ({ id: a.id, question: a.question })) };
}

/** The questions a message was picked for; none for one that was typed. */
export function answersOf(content: AgentMessageContent): AnsweredQuestion[] {
  if (content.type !== "text") return [];
  const raw = content.metadata?.[ANSWERS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, question } = entry as { id?: unknown; question?: unknown };
    return typeof id === "string" && id ? [{ id, question: typeof question === "string" ? question : "" }] : [];
  });
}

/** The questions a message closes without answering them: those the user
 *  skipped, and those a message written under an earlier rule closed (words
 *  that named no question answered every open one; kept on it by a
 *  migration). The model never reads the mark itself. */
function closedOf(content: AgentMessageContent): unknown[] {
  const raw = content.type === "text" ? content.metadata?.[CLOSED_KEY] : undefined;
  return Array.isArray(raw) ? raw : [];
}

/** The row that says the user skipped a question: it closes the question,
 *  and tells the asker, when it next looks, in so many words. */
export function skippedContent(question: Pick<OpenQuestion, "id" | "question">): AgentMessageContent {
  return {
    type: "text",
    text: `The user skipped your question "${questionInOneLine(question.question)}".`,
    metadata: { [CLOSED_KEY]: [question.id] }
  };
}

/** The questions a row says the user skipped; none for any other row. */
export function skippedOf(row: Pick<QuestionRow, "role" | "source" | "content">): string[] {
  if (row.role !== "user" || row.source !== "question-skip") return [];
  return closedOf(row.content).filter((id): id is string => typeof id === "string");
}

function resultOf(content: AgentMessageContent, toolName: string): Record<string, unknown> | null {
  if (content.type !== "tool_result" || content.toolName !== toolName || content.isError) return null;
  const result = content.result;
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
}

const QUESTION_LINE_MAX_CHARS = 200;

/** A question's words on one line, as a line written for a model names it:
 *  its line breaks run together, a long one cut. */
export function questionInOneLine(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > QUESTION_LINE_MAX_CHARS ? `${flat.slice(0, QUESTION_LINE_MAX_CHARS - 1)}…` : flat;
}

/** Suggested answers as they were stored: what is not one is left out. */
export function optionsOf(raw: unknown): QuestionOption[] {
  return (Array.isArray(raw) ? raw : []).flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const { label, description } = option as { label?: unknown; description?: unknown };
    if (typeof label !== "string" || !label) return [];
    return [typeof description === "string" && description ? { label, description } : { label }];
  });
}

/** The question a row asked, or null: only what the ask tool accepted. */
export function askedOf(content: AgentMessageContent, createdAt: string): OpenQuestion | null {
  const result = resultOf(content, ASK_TOOL);
  if (!result || result.asked !== true) return null;
  const { questionId, question, options } = result;
  if (typeof questionId !== "string" || !questionId || typeof question !== "string") return null;
  return {
    id: questionId,
    question,
    options: optionsOf(options),
    askedAt: createdAt
  };
}

/** The id a row took back, or null: only a withdrawal that went through. */
export function withdrawnOf(content: AgentMessageContent): string | null {
  const result = resultOf(content, WITHDRAW_TOOL);
  return result && result.withdrawn === true && typeof result.questionId === "string" ? result.questionId : null;
}

/** A message on the user's side that can be an answer: anything but what a
 *  control sent for them. Only a message that names its question answers it,
 *  and only the user's own (a pick, an answer typed in the question, their
 *  agent's answer for them) are ever written naming one. */
function isTheUsers(row: QuestionRow): boolean {
  return row.role === "user" && !sentByControl(row.content);
}

/** The open questions after one more row. */
export function foldQuestions(open: readonly OpenQuestion[], row: QuestionRow): OpenQuestion[] {
  if (row.role === "tool") {
    const asked = askedOf(row.content, row.createdAt);
    if (asked) return [...open.filter((q) => q.id !== asked.id), asked];
    const withdrawn = withdrawnOf(row.content);
    return withdrawn ? open.filter((q) => q.id !== withdrawn) : [...open];
  }
  if (!isTheUsers(row)) return [...open];
  const answered = new Set([...answersOf(row.content).map((a) => a.id), ...closedOf(row.content)]);
  return open.filter((q) => !answered.has(q.id));
}

export function openQuestionsOf(rows: readonly QuestionRow[]): OpenQuestion[] {
  return rows.reduce<OpenQuestion[]>((open, row) => foldQuestions(open, row), []);
}

/** The open questions less what queued messages already answer: the user
 *  answered when the message was taken, not when the asker reads it. */
export function withoutQueuedAnswers(open: readonly OpenQuestion[], queued: readonly QueuedAnswer[]): OpenQuestion[] {
  const answered = new Set(queued.flatMap((q) => q.answers.map((a) => a.id)));
  return open.filter((q) => !answered.has(q.id));
}
