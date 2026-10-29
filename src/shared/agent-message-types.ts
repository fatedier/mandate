// Wire types shared between server (persists / streams) and client (renders)
// for agent thread messages. Pure type-only; no runtime imports so Vite can
// tree-shake to nothing on the client side and Bun has no extra surface on
// the server side.

import type { AssistantModelMessage } from "ai";
export type { ModelInputType } from "./settings";

export type AgentRole = "user" | "assistant" | "tool" | "system";

export type AgentMessageSource =
  | "user" | "manager"
  | "self" | "compression" | "runtime-context"
  | "alarm" | "watch" | "monitor"
  | "restart-recovery"
  | "voice"
  | "feature-message"
  | "worker-report"
  | "thread-notice"
  | "plan-reminder"
  | "wake-failure"
  /** The user skipped a question without answering it: the asker reads so;
   *  the page shows it on the question's line, not as a row. */
  | "question-skip"
  /** The user changed a project's working directory: those working in it
   *  read so; the page shows it as a line. */
  | "project-change"
  /** A reply was cut off at the output token limit: the model is told how
   *  to go on. */
  | "output-limit"
  /** A subagent's task: the first message of its thread. */
  | "subagent-task"
  /** A subagent's result, in the conversation that started it. */
  | "subagent-result"
  /** A background command's end, in the conversation that started it. */
  | "command-result"
  /** What the user gave on Your agent's page, for Your agent to read. */
  | "page-input"
  /** How a change to Your agent's page went, for Your agent to read. */
  | "page-result";

/** Sources the model reads and nobody else does: the runtime context it is
 *  routed with, the plan reminder, and the note after a cut-off reply. They
 *  are never shown, searched, read back, or kept through compaction. */
const MODEL_ONLY_SOURCES = ["runtime-context", "plan-reminder", "output-limit"] as const satisfies readonly AgentMessageSource[];

export function isModelOnlySource(source: AgentMessageSource | undefined): boolean {
  return (MODEL_ONLY_SOURCES as readonly string[]).includes(source ?? "");
}

/** Notes about Your agent's page: the model reads them and they stay in the
 *  thread through compaction, but the chat never draws them and voice never
 *  speaks them. */
const PAGE_NOTE_SOURCES = ["page-input", "page-result"] as const satisfies readonly AgentMessageSource[];

export function isPageNoteSource(source: AgentMessageSource | undefined): boolean {
  return (PAGE_NOTE_SOURCES as readonly string[]).includes(source ?? "");
}

/** The same sources as an SQL list, for filters that run in the database. */
export const MODEL_ONLY_SOURCES_SQL = MODEL_ONLY_SOURCES.map((source) => `'${source}'`).join(", ");

/** Set on a message the global agent sent for the user. */
export interface RelayMarker {
  by: "global";
  spoken: boolean;
  handoffId: string;
  /** The agent's name when it sent this: the receiving model is told who wrote it. */
  name?: string;
}

/** Plain text — user input, system events, etc. */
interface TextContent {
  type: "text";
  text: string;
  attachments?: AgentMessageAttachment[];
  /** Client-generated id used to reconcile optimistic/queued user messages. */
  clientRequestId?: string;
  featureId?: string | null;
  featureName?: string;
  wakeId?: string;
  /** Arbitrary structured metadata (e.g. mentions, answers). */
  metadata?: Record<string, unknown>;
  /** Set when the global agent sent this for the user: shown as "via
   *  <name>", and how its handoff finds its message. */
  relay?: RelayMarker;
  /** When it reached Mandate, set when it waited (in the mailbox, or behind
   *  a running turn) before it joined the conversation: the time the model
   *  reads on it. Unset: the message's own time. */
  arrivedAt?: string;
}

interface ImageAttachment {
  type: "image";
  id: string;
  name?: string;
  mediaType: string;
  /** Raw base64 payload, without the data: URL prefix. Empty in what the
   *  server sends a browser, which fetches the image from `url`. */
  data: string;
  sizeBytes: number;
  /** Where a browser fetches the image (`?size=thumb` for a thumbnail); set
   *  only on what the server sends it. */
  url?: string;
}

export type AgentMessageAttachment = ImageAttachment;

interface ToolImageResult {
  type: "image";
  id: string;
  name: string;
  displayPath: string;
  mediaType: string;
  /** Raw base64 payload, without the data: URL prefix. Empty in what the
   *  server sends a browser, which fetches the image from `url`. */
  data: string;
  sizeBytes: number;
  /** Where a browser fetches the image (`?size=thumb` for a thumbnail); set
   *  only on what the server sends it. */
  url?: string;
}

export interface ToolImageResultContent {
  type: "view_image_result";
  image: ToolImageResult;
  message: string;
}

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export type AiSdkAssistantMessage = AssistantModelMessage;

/** Assistant turn — may carry visible text/tool calls for Mandate UI and SDK
 *  assistant messages for provider-side continuation state. An assistant turn
 *  with no visible text/tool calls still ends the wake. */
export interface AssistantContent {
  type: "assistant";
  text?: string;
  toolCalls?: ToolCall[];
  /** False on a step the model said does not end its turn (a Codex
   *  commentary): the turn goes on after it even when it called no tool. */
  endTurn?: boolean;
  /** The step's reasoning summary (parts as paragraphs) and how long it
   *  reasoned. Kept, not shown: the page hears only its live heading. */
  reasoning?: { text: string; ms: number };
  sdkAssistantMessages?: AiSdkAssistantMessage[];
  /** The model that wrote the step: its provider and model id. The stored
   *  provider state above goes back only to a model with the same id. */
  writtenBy?: { provider: string; model: string };
  /** Voice told the user something Mandate reported (a handoff's reply, a
   *  worker now waiting), not an answer to them: the page labels it. */
  spokenUpdate?: boolean;
}

/** Tool execution result. Either `isError + error` or `result`, never both. */
interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  isError?: boolean;
  error?: string;
  result?: unknown | ToolImageResultContent;
}

/** Compression summary placeholder — replaces a contiguous range of older
 *  messages. `replacedRange` and `replacedCount` are computed on DIFFERENT
 *  sets and do not describe each other: the range spans everything the
 *  summariser read, which includes the turns still live in the window, while
 *  the count covers only the messages this summary actually hid. Expect
 *  `replacedCount` to be smaller than the range implies. Note also that summary
 *  rows written before the retention change carry the old, larger basis for
 *  `replacedCount` — everything the summariser read — and nothing recomputes
 *  them, so both bases coexist in an existing database.
 *  `retained` names the older messages that survive the compression anyway —
 *  recent user turns, kept because a summary paraphrases and user instructions
 *  are exactly what must not be paraphrased. `truncatedText`, when present,
 *  means that turn is too large to keep whole: derive it with this text in
 *  place of its stored content. */
interface SummaryContent {
  type: "summary";
  summary: string;
  replacedRange: [number, number];
  replacedCount: number;
  /** What this compaction compacted itself: the messages it hid, the
   *  previous summary it folds in counting as none (`replacedCount` takes that
   *  summary's own count in, so it is the conversation's running total). The
   *  count the transcript's boundary shows. Absent on a row whose own share
   *  could not be told. */
  compactedCount?: number;
  retained: Array<{ id: string; truncatedText?: string }>;
  /** The context's size in tokens when this compaction was triggered, as its
   *  gate measured it: the provider's own count of the last prompt plus an
   *  estimate of what was added since, the figure compared with the
   *  threshold. Absent when the gate had no such count (the plain estimate
   *  runs well above it and is not recorded in its place), and on rows
   *  written before 2026-10-09. Shown to the user on the transcript's
   *  boundary, never sent to the model. */
  tokensBefore?: number;
  /** Set on a compaction that ran because the thread sat idle before its
   *  prompt cache expired (idle compaction): not the thread's activity. */
  trigger?: "idle";
  /** With `trigger`: the minutes it waited since the cache was last kept. */
  idleMinutes?: number;
}

/** A turn that ended without finishing — an error, or the same call failing
 *  over and over (stuck) — as a row in its thread where it stopped. Stored with role "system": people see it, the model,
 *  compression and search do not. */
export interface WakeFailureContent {
  type: "wake_failure";
  /** cut_off: the replies kept stopping at the output token limit. */
  status: "error" | "stuck" | "cut_off";
  /** What the user is told went wrong; for `stuck` the repeated failure. */
  message: string | null;
  stepCount: number;
}

export type AgentMessageContent =
  | TextContent
  | AssistantContent
  | ToolResultContent
  | SummaryContent
  | WakeFailureContent;
