import type { AgentMessageContent } from "../../../shared/agent-message-types.js";
import type { AgentStore, AgentMessage } from "./agent-store.js";
import { limitToolText } from "./tool-result-format.js";
import { prepareAiSdkMessages } from "./wake-message-adapter.js";
import { isModelOnlySource } from "../../../shared/agent-message-types.js";
import { positiveNumberOrNull } from "../../../shared/positive-number.js";

interface CompressionConfig {
  thresholdTokens: number;
}

interface CompressionGateTokenSignal {
  /** Last successful wake-step LLM input-token count for this thread. */
  previousInputTokens?: number | null;
  /** Max agent_messages.seq included in that previous wake-step prompt. */
  previousPromptMaxSeq?: number | null;
}

type CompressionGateEstimateStrategy =
  | "active_message_estimate"
  | "active_message_estimate_after_compression"
  | "previous_input_plus_new_messages";

interface CompressionGateDecision {
  shouldCompress: boolean;
  triggerTokens: number;
  thresholdTokens: number;
  strategy: CompressionGateEstimateStrategy;
  estimatedActiveTokens: number;
  previousInputTokens: number | null;
  previousPromptMaxSeq: number | null;
  newMessageTokens: number | null;
  projectedTokens: number | null;
}

interface SummarizerResult {
  summaryText: string;
}

type Summarizer = (messages: AgentMessage[], threadId: string) => Promise<SummarizerResult>;

interface CompressionDeps {
  agentStore: AgentStore;
  summarizer: Summarizer;
  /** Optional so existing callers and tests need no change. */
  cursors?: { resetThread(threadId: string): void };
  /** The compression threshold this run was gated on, when the caller knows it.
   *  Optional for the same reason as `cursors`. Used to keep the retention
   *  budget smaller than the window it is retained into. */
  thresholdTokens?: number;
  /** The window's size as the gate measured it against that threshold, when
   *  it had the provider's count of the last prompt to go by: recorded on the
   *  summary for the transcript to say. Never the plain estimate. */
  measuredTokens?: number;
  /** An idle compaction's tag, written on its summary (idle compaction). */
  summaryTag?: { trigger: "idle"; idleMinutes: number };
}

interface CompressionRunResult {
  summaryMessage: AgentMessage;
  replacedRange: [number, number];
  replacedCount: number;
  /** What this compression took out of the model's context: memory
   *  extraction reads exactly these, so each message is read once. */
  hiddenMessages: AgentMessage[];
}

const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const TOKEN_ESTIMATE_SAFETY_MARGIN = 1.15;
const NON_LATIN_RE = /[\u2E80-\u9FFF\uA000-\uA4FF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{2FA1F}]/gu;
const CJK_SURROGATE_HIGH_RE = /[\uD840-\uD87E][\uDC00-\uDFFF]/g;

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  const modelMessages = prepareAiSdkMessages(messages, { includeImages: false });
  let rawTokens = 0;
  for (const message of modelMessages) {
    rawTokens += estimateStringTokens(JSON.stringify(message));
  }
  return Math.ceil(rawTokens * TOKEN_ESTIMATE_SAFETY_MARGIN);
}

/** A text's size in tokens, estimated as the compressor estimates messages. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(estimateStringTokens(text) * TOKEN_ESTIMATE_SAFETY_MARGIN);
}

function estimateStringTokens(text: string): number {
  return Math.ceil(estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE);
}

function estimateStringChars(text: string): number {
  if (text.length === 0) return 0;
  const nonLatinCount = (text.match(NON_LATIN_RE) ?? []).length;
  if (nonLatinCount === 0) return text.length;
  const cjkSurrogates = (text.match(CJK_SURROGATE_HIGH_RE) ?? []).length;
  const codePointLength = text.length - cjkSurrogates;
  return codePointLength + nonLatinCount * (CHARS_PER_TOKEN_ESTIMATE - 1);
}

function messageRange(message: AgentMessage): [number, number] {
  if (message.content.type !== "summary") return [message.seq, message.seq];
  const [start, end] = message.content.replacedRange;
  return start <= end ? [start, end] : [end, start];
}

function messageReplacedCount(message: AgentMessage): number {
  return message.content.type === "summary" ? message.content.replacedCount : 1;
}

function compressionRange(messages: AgentMessage[]): [number, number] {
  const ranges = messages.map(messageRange);
  return [
    Math.min(...ranges.map(([start]) => start)),
    Math.max(...ranges.map(([, end]) => end))
  ];
}

export function getCompressionGateDecision(
  messages: AgentMessage[],
  config: CompressionConfig,
  tokenSignal: CompressionGateTokenSignal = {}
): CompressionGateDecision {
  const estimate = estimateCompressionGateTokens(messages, tokenSignal);
  return {
    ...estimate,
    thresholdTokens: config.thresholdTokens,
    shouldCompress: estimate.triggerTokens >= config.thresholdTokens
  };
}

interface CompactionSelection {
  toSummarize: AgentMessage[];
  toHideFromPrompt: AgentMessage[];
  retainedUserMessages: AgentMessage[];
}

interface CompactionOptions {
  /** Retention budget in this module's token estimate. Defaults to the flat cap. */
  maxTokens?: number;
}

function selectMessagesForCompaction(
  messages: AgentMessage[],
  options: CompactionOptions = {}
): CompactionSelection {
  // Order matters: the retained set must be final before toHideFromPrompt is
  // derived from it. replacedCount is counted off toHideFromPrompt, so dropping
  // a retained entry afterwards would hide a turn nobody counted as replaced.
  const retainedUserMessages = selectRecentUserMessagesForCompaction(messages, options.maxTokens);
  const retained = new Set(retainedUserMessages);
  return {
    // The summariser gets the whole active window. Filtering it here used to
    // hide runtime context from the summary, which cost it the environment the
    // conversation happened in. Staleness is handled downstream instead:
    // ensurePromptContextMessages re-injects a fresh snapshot after compression.
    toSummarize: messages,
    toHideFromPrompt: messages.filter((message) => !retained.has(message)),
    retainedUserMessages
  };
}

function selectRecentUserMessagesForCompaction(
  messages: AgentMessage[],
  maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS
): AgentMessage[] {
  const selected: AgentMessage[] = [];
  let selectedTokens = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!isRetainableUserMessage(message)) continue;

    const nextTokens = estimateMessagesTokens([message]);
    if (selected.length > 0 && selectedTokens + nextTokens > maxTokens) break;
    selected.push(message);
    selectedTokens += nextTokens;
    if (selectedTokens >= maxTokens) break;
  }

  return selected.reverse();
}

/** What starting a compaction by hand answers: it started; the window holds
 *  nothing a summary would replace; a turn has the thread; one started by
 *  hand is already in flight. */
export type ManualCompactionOutcome = "started" | "nothing" | "running" | "compacting";

/** Whether a selection would hide anything a summary can stand for. */
function hidesSomething(selection: CompactionSelection): boolean {
  return selection.toSummarize.length > 0 && selection.toHideFromPrompt.some(isSummarizableForCompression);
}

/** Whether compacting this window now would do anything: the check
 *  runCompression makes before it calls the summariser, for a caller that
 *  must answer "nothing to compact" without starting one. */
export function hasSomethingToCompact(messages: AgentMessage[], thresholdTokens?: number): boolean {
  return hidesSomething(selectMessagesForCompaction(messages, { maxTokens: retentionBudgetTokens(thresholdTokens) }));
}

export async function runCompression(deps: CompressionDeps, threadId: string): Promise<CompressionRunResult | null> {
  const active = deps.agentStore.getActiveMessages(threadId);
  const retentionBudget = retentionBudgetTokens(deps.thresholdTokens);
  const selection = selectMessagesForCompaction(active, {
    maxTokens: retentionBudget
  });
  if (!hidesSomething(selection)) return null;

  // The summariser reads the whole window, runtime context included (it needs
  // what was on screen), but not a plan reminder: its copy of the plan is
  // stale by the time the fresh one is appended after the summary. Nor the
  // note after a cut-off reply: an instruction for that one next step.
  const result = await deps.summarizer(
    selection.toSummarize.filter((m) => m.source !== "plan-reminder" && m.source !== "output-limit"),
    threadId
  );
  const summaryText = normalizeCompressionSummaryText(result.summaryText);
  const replacedRange = compressionRange(selection.toSummarize);
  // Count what this summary actually replaces, which is what gets hidden — not
  // everything the summariser read. Since the summariser started seeing the
  // whole active window, `toSummarize` also contains the turns that survive;
  // counting those made a retained turn count twice on the next compression,
  // once as its own live row and once inside the prior summary's count.
  const replacedCount = selection.toHideFromPrompt.reduce(
    (count, message) => count + messageReplacedCount(message),
    0
  );
  // A row written while the summariser ran (a voice transcript in the global
  // thread) will sit behind the summary, out of the window too. Read now,
  // with nothing awaited between here and the append, it is exactly the rows
  // the summary will cover beyond the window it read.
  const lastSeenSeq = active.reduce((max, message) => Math.max(max, message.seq), 0);
  const arrivedMeanwhile = deps.agentStore.getMessagesSince(threadId, lastSeenSeq)
    .filter((message) => message.role !== "system");
  // What this compaction compacted itself, as its boundary says: every row it
  // hides, the late ones included; the previous summary it folds in brings
  // that summary's count into `replacedCount`, and none into this.
  const compactedCount = selection.toHideFromPrompt.filter((message) => message.content.type !== "summary").length
    + arrivedMeanwhile.length;

  // Append the summary as a normal timeline event so UI pagination and
  // since=seq catch-up can recover it. Active model history is derived at
  // read time from appended compression summaries; older thread rows are not
  // updated or deleted.
  // Stored as role:"user" (not "system") so the LLM-facing message stream
  // contains only user/assistant/tool turns. role:"system" mid-conversation
  // is rejected by Anthropic and treated as an instruction by OpenAI — both
  // are wrong for what is really a historical-summary marker. We keep
  // source:"compression" as metadata so the UI can render it distinctly
  // and so the wake-loop can wrap the summary text with a prefix when
  // building the LLM prompt.
  const content: Extract<AgentMessageContent, { type: "summary" }> = {
    type: "summary",
    summary: summaryText,
    replacedRange,
    replacedCount,
    compactedCount,
    retained: buildRetainedEntries(selection.retainedUserMessages, retentionBudget),
    ...(deps.measuredTokens ? { tokensBefore: deps.measuredTokens } : {}),
    ...(deps.summaryTag ?? {})
  };
  const summary = deps.agentStore.appendMessage({
    threadId, role: "user", source: "compression",
    content
  });
  // Summarized-away messages may have held the pane lines the read cursor still
  // assumes the agent can see. Drop them so the next read_pane returns in full.
  deps.cursors?.resetThread(threadId);
  // The rows written while the summariser ran leave with the hidden ones, so
  // extraction still reads them once.
  return {
    summaryMessage: summary,
    replacedRange,
    replacedCount,
    hiddenMessages: [...selection.toHideFromPrompt, ...arrivedMeanwhile]
  };
}

/** A retained turn is referenced by id so the append-only log stays the single
 *  source of truth. The one exception is a turn that alone blows the budget:
 *  the selection loop always keeps the newest retainable turn regardless of
 *  size, and keeping a 180k-token paste whole would leave compression with
 *  nothing to reclaim. Those carry a truncated copy instead. */
function buildRetainedEntries(
  messages: AgentMessage[],
  maxTokens: number
): Array<{ id: string; truncatedText?: string }> {
  return messages.map((message) => {
    if (message.content.type !== "text") return { id: message.id };
    const text = message.content.text;
    const limited = limitToolText(text, retainedTextCharBudget(text, maxTokens));
    // Nothing was actually cut, so there is nothing to substitute: reference the
    // row by id and store no copy. Skipping this check is how a "truncated" copy
    // ends up byte-identical to the row it references.
    if (!limited.truncated) return { id: message.id };
    // limitToolText appends its "... [truncated N chars]" notice after the cut,
    // so just above the budget the notice costs more than the cut saves and the
    // copy comes out no shorter than the row. Storing that is strictly worse
    // than referencing the row.
    if (limited.text.length >= text.length) return { id: message.id };
    return { id: message.id, truncatedText: limited.text };
  });
}

/** The retention budget has to fit inside the window it is retained into. With
 *  a flat 20_000 tokens and a threshold in the 3k-25k band — a reasonable
 *  setting for a 32k-context local model — a compression puts back more user
 *  text than the entire threshold allows: the window is still over threshold
 *  with an identical retained set, so the next wake step compresses again, and
 *  the next, appending a summary row every time. A quarter of the threshold
 *  leaves room for the summary and for the turns that follow it. */
function retentionBudgetTokens(thresholdTokens: number | undefined): number {
  if (thresholdTokens === undefined || !Number.isFinite(thresholdTokens) || thresholdTokens <= 0) {
    return COMPACT_USER_MESSAGE_MAX_TOKENS;
  }
  return Math.min(COMPACT_USER_MESSAGE_MAX_TOKENS, Math.floor(thresholdTokens / 4));
}

/** The budget is a count of this module's token estimate, but limitToolText cuts
 *  by raw character count, and the two disagree: estimateStringChars weighs one
 *  CJK character as 4, and estimateMessagesTokens then applies a 1.15 safety
 *  margin. Cutting by raw length would let a Chinese paste through at ~4.6x the
 *  budget. Convert the budget into however many raw characters THIS text can
 *  afford. The newest retainable turn is kept whatever its size, so this is the
 *  only bound on how much of an oversized paste survives — it takes the same
 *  clamped budget as the selection, or a small threshold would still be blown
 *  by a single turn. */
function retainedTextCharBudget(text: string, maxTokens: number): number {
  const budgetEffectiveChars = Math.floor(
    (maxTokens * CHARS_PER_TOKEN_ESTIMATE) / TOKEN_ESTIMATE_SAFETY_MARGIN
  );
  const effective = estimateStringChars(text);
  if (effective <= budgetEffectiveChars) return text.length;
  return Math.max(1, Math.floor(budgetEffectiveChars * (text.length / effective)));
}

function isRetainableUserMessage(message: AgentMessage): boolean {
  if (message.role !== "user") return false;
  if (message.source === "compression") return false;
  if (isModelOnlySource(message.source)) return false;
  return message.content.type === "text";
}

function isSummarizableForCompression(message: AgentMessage): boolean {
  return !isModelOnlySource(message.source);
}

/** The model finished normally but wrote nothing. A glitch of that call, not of
 *  the request, so compression gives it one more try on the same model. */
export class EmptyCompressionSummaryError extends Error {
  constructor() {
    super("compression produced empty summary");
    this.name = "EmptyCompressionSummaryError";
  }
}

export function normalizeCompressionSummaryText(summaryText: string): string {
  const text = summaryText.trim();
  if (!text) {
    throw new EmptyCompressionSummaryError();
  }
  return text;
}

function estimateCompressionGateTokens(
  messages: AgentMessage[],
  tokenSignal: CompressionGateTokenSignal
): Omit<CompressionGateDecision, "shouldCompress" | "thresholdTokens"> {
  const estimatedActiveTokens = estimateMessagesTokens(messages);
  const previousInputTokens = positiveNumberOrNull(tokenSignal.previousInputTokens);
  const previousPromptMaxSeq = positiveNumberOrNull(tokenSignal.previousPromptMaxSeq);
  if (previousInputTokens === null || previousPromptMaxSeq === null) {
    return {
      triggerTokens: estimatedActiveTokens,
      strategy: "active_message_estimate",
      estimatedActiveTokens,
      previousInputTokens,
      previousPromptMaxSeq,
      newMessageTokens: null,
      projectedTokens: null
    };
  }

  // If a compression summary was appended after the previous prompt, the old
  // input token count described pre-compression history. Fall back to the
  // active-message estimate rather than double-counting replaced content.
  const historyWasCompressedAfterPreviousPrompt = historyWasCompressedAfterPrompt(messages, previousPromptMaxSeq);
  if (historyWasCompressedAfterPreviousPrompt) {
    return {
      triggerTokens: estimatedActiveTokens,
      strategy: "active_message_estimate_after_compression",
      estimatedActiveTokens,
      previousInputTokens,
      previousPromptMaxSeq,
      newMessageTokens: null,
      projectedTokens: null
    };
  }

  const newMessages = messages.filter((message) => message.seq > previousPromptMaxSeq);
  const newMessageTokens = estimateMessagesTokens(newMessages);
  const projectedTokens = previousInputTokens + newMessageTokens;
  return {
    triggerTokens: projectedTokens,
    strategy: "previous_input_plus_new_messages",
    estimatedActiveTokens,
    previousInputTokens,
    previousPromptMaxSeq,
    newMessageTokens,
    projectedTokens
  };
}

function historyWasCompressedAfterPrompt(messages: AgentMessage[], previousPromptMaxSeq: number): boolean {
  return messages.some((message) =>
    message.seq > previousPromptMaxSeq && message.source === "compression"
  );
}
