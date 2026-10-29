import { createHash } from "node:crypto";
import { asSchema, type ModelMessage, type SystemModelMessage, type ToolSet } from "ai";
import { withAnthropicMark, withoutAnthropicCacheMarks } from "../../llm/anthropic-cache.js";

/** What stands for a tool's result that the seal does not send. */
export const SEAL_PLACEHOLDER_RESULT = "(pending)";
/** What follows a reply with no tool calls: a request may not end on the
 *  model's own message (a prefill, refused). */
export const SEAL_PLACEHOLDER_USER_TEXT = ".";
/** A seal asks for one token; more than this and it cost more than it should. */
export const SEAL_MAX_OUTPUT_TOKENS = 16;

const FIVE_MINUTES = 300_000;
const ONE_HOUR = 3_600_000;
/** The share of the sealed prompt the next step must read after a pause. */
const SEALED_READ_SHARE = 0.8;

/**
 * A seal of a step's prompt (as the next step would send it): every mark
 * off, cut after the last assistant message, that message marked for an hour,
 * then a pending result for each of its tool calls — or, after a reply with
 * no tool calls, a user message with a dot. Both come after the mark, so they
 * are never cached. Null when there is no assistant message to seal.
 */
export function sealMessages(stepMessages: readonly ModelMessage[]): { messages: ModelMessage[]; sealedCount: number } | null {
  const plain = withoutAnthropicCacheMarks(stepMessages);
  const last = plain.findLastIndex((message) => message.role === "assistant");
  if (last < 0) return null;
  const reply = plain[last]!;
  const calls = Array.isArray(reply.content) ? reply.content.flatMap((part) => (part.type === "tool-call" ? [part] : [])) : [];
  const tail: ModelMessage[] = calls.length > 0
    ? [{ role: "tool", content: calls.map((call) => ({ type: "tool-result" as const, toolCallId: call.toolCallId, toolName: call.toolName, output: { type: "text" as const, value: SEAL_PLACEHOLDER_RESULT } })) }]
    : [{ role: "user", content: [{ type: "text", text: SEAL_PLACEHOLDER_USER_TEXT }] }];
  return { messages: [...plain.slice(0, last), withAnthropicMark(reply, "1h"), ...tail], sealedCount: last + 1 };
}

/**
 * A hash of the part of a request a seal keeps: the system instruction, the
 * tools (name, description, input schema), the call options and the first
 * `count` messages, every cache mark taken off. Built the same way for the
 * seal and for the next step, it is equal exactly when the next step sends
 * the sealed part again byte for byte.
 */
export async function sealFingerprint(input: {
  system: string | SystemModelMessage;
  tools: ToolSet;
  callOptions: { providerOptions?: unknown; headers?: unknown; reasoning?: unknown };
  messages: readonly ModelMessage[];
  count: number;
}): Promise<string> {
  const system = typeof input.system === "string" ? input.system : withoutAnthropicCacheMarks([input.system as ModelMessage])[0];
  const tools = await toolsAsSent(input.tools);
  const messages = withoutAnthropicCacheMarks(input.messages.slice(0, input.count));
  const text = JSON.stringify({ system, tools, callOptions: input.callOptions, messages });
  return createHash("sha256").update(text).digest("hex");
}

/** A hash of the system instruction alone, its mark taken off: a step whose
 *  instruction was refreshed on purpose is excused, not a failed seal. */
export function systemFingerprint(system: string | SystemModelMessage): string {
  const plain = typeof system === "string" ? system : withoutAnthropicCacheMarks([system as ModelMessage])[0];
  return createHash("sha256").update(JSON.stringify(plain)).digest("hex");
}

/** A hash of the tools offered alone: a step whose tools changed on purpose
 *  (web search switched on or off) is excused, not a failed seal. */
export async function toolSetFingerprint(tools: ToolSet): Promise<string> {
  return createHash("sha256").update(JSON.stringify(await toolsAsSent(tools))).digest("hex");
}

/** Each tool as it reaches the request: name, description, input schema. */
async function toolsAsSent(tools: ToolSet) {
  return Promise.all(Object.keys(tools).sort().map(async (name) => {
    const tool = tools[name]!;
    return { name, description: tool.description ?? null, schema: tool.inputSchema ? await asSchema(tool.inputSchema).jsonSchema : null };
  }));
}

/** Layer 1: what the seal's own response says about its write. */
export function judgeSealWrite(r: { outputTokens: number; cacheWriteTokens: number; cacheWrite1h: number | undefined }): "pass" | "neutral" | "short_write" | "output" {
  if (r.outputTokens > SEAL_MAX_OUTPUT_TOKENS) return "output";
  if ((r.cacheWrite1h ?? 0) > 0) return "pass";
  if (r.cacheWriteTokens <= 0) return "neutral";
  return "short_write";
}

/** Layer 2: what the thread's next step found of the seal. */
export function judgeNextStep(r: {
  sealedFingerprint: string;
  stepFingerprint: string;
  excused: boolean;
  gapMs: number;
  sealedTokens: number;
  cacheReadTokens: number;
}): "pass" | "excused" | "not_read" | "prefix_changed" {
  if (r.excused) return "excused";
  if (r.sealedFingerprint !== r.stepFingerprint) return "prefix_changed";
  const judged = r.gapMs >= FIVE_MINUTES && r.gapMs <= ONE_HOUR;
  if (judged && r.cacheReadTokens < SEALED_READ_SHARE * r.sealedTokens) return "not_read";
  return "pass";
}
