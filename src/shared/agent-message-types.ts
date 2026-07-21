// Wire types shared between server (persists / streams) and client (renders)
// for agent thread messages. Pure type-only; no runtime imports so Vite can
// tree-shake to nothing on the client side and Bun has no extra surface on
// the server side.

import type { AssistantModelMessage } from "ai";
import type { UiLocation } from "./ui-context";
export type { ModelInputType } from "./settings";

export type AgentRole = "user" | "assistant" | "tool" | "system";

export type AgentMessageSource =
  | "user" | "manager" | "analyzer-event" | "scheduled"
  | "self" | "compression" | "runtime-context"
  | "alarm" | "watch"
  | "restart-recovery"
  | "voice"
  | "feature-event"
  | "feature-message"
  | "side-boundary"
  | "side-summary";

/** Plain text — user input, system events, etc. */
interface TextContent {
  type: "text";
  text: string;
  attachments?: AgentMessageAttachment[];
  /** Client-generated id used to reconcile optimistic/queued user messages. */
  clientRequestId?: string;
  /** Browser/client instance that submitted this message. Used only to route
   *  explicit UI summary tool requests back to the right frontend. */
  clientId?: string;
  /** Lightweight route metadata. Full page details are fetched only when an
   *  agent explicitly calls ui_read_page_summary. */
  uiLocation?: UiLocation;
  featureId?: string | null;
  featureName?: string;
  wakeId?: string;
  /** Arbitrary structured metadata (e.g. workItemRef). */
  metadata?: Record<string, unknown>;
}

interface ImageAttachment {
  type: "image";
  id: string;
  name?: string;
  mediaType: string;
  /** Raw base64 payload, without the data: URL prefix. */
  data: string;
  sizeBytes: number;
}

export type AgentMessageAttachment = ImageAttachment;

interface ToolImageResult {
  type: "image";
  id: string;
  name: string;
  displayPath: string;
  mediaType: string;
  /** Raw base64 payload, without the data: URL prefix. */
  data: string;
  sizeBytes: number;
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
  sdkAssistantMessages?: AiSdkAssistantMessage[];
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

interface CanvasFeatureEventArtifact {
  type: "canvas";
  canvasId: string;
  title: string;
  path: string;
  role?: string;
}

export type FeatureEventArtifact = CanvasFeatureEventArtifact;

interface FeatureEventProjectSnapshot {
  id?: string;
  name?: string;
}

interface FeatureEventFeatureSnapshot {
  id: string;
  name?: string;
}

interface FeatureEventWorkItemSnapshot {
  id?: string;
  title?: string;
}

export interface FeatureEventSourceSnapshot {
  project?: FeatureEventProjectSnapshot;
  feature: FeatureEventFeatureSnapshot;
  workItem?: FeatureEventWorkItemSnapshot;
  capturedAt: string;
}

/** Mailbox-delivered feature event: a task required user/caller attention
 *  (escalation, from task_notify_caller blocked|needs_user), finished
 *  (completion, from task_complete when the task has a caller), or hit its
 *  wake step limit before finishing (limit_reached).
 *  Info/progress notifications stay silent (lastNote only) and never become
 *  events here. Overview is woken whenever one of these is enqueued. */
interface FeatureEventBaseContent {
  type: "feature_event";
  featureId: string;
  workItemId: string | null;
  /** Best-effort user-facing source labels captured when the event was created. */
  source?: FeatureEventSourceSnapshot;
  label: string;          // task or feature title at event time
  summary: string;
  artifacts?: FeatureEventArtifact[];
}

interface TaskFeatureEventContent extends FeatureEventBaseContent {
  taskId: string;
}

export type FeatureEventContent =
  | (TaskFeatureEventContent & {
    kind: "escalation";
    /** Only set when kind === "escalation". */
    signal?: "blocked" | "needs_user";
  })
  | (TaskFeatureEventContent & {
    kind: "completion";
  })
  | (FeatureEventBaseContent & {
    kind: "limit_reached";
    stepCount: number;
  });

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
 *  place of its stored content. Optional: rows written before this field
 *  existed derive as if it were empty. */
interface SummaryContent {
  type: "summary";
  summary: string;
  replacedRange: [number, number];
  replacedCount: number;
  retained?: Array<{ id: string; truncatedText?: string }>;
}

export type AgentMessageContent =
  | TextContent
  | AssistantContent
  | ToolResultContent
  | SummaryContent
  | FeatureEventContent;
