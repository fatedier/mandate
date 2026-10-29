import { expect, test } from "bun:test";
import { tool, type ModelMessage } from "ai";
import { z } from "zod";
import { judgeNextStep, judgeSealWrite, sealFingerprint, sealMessages } from "../src/server/modules/agent/cache-seal/seal-request.js";
import { sealParticipates } from "../src/server/modules/agent/cache-seal/seal-family.js";

// What a seal sends, how it is told apart from the next step's prompt, and
// the two judgements.

const HOUR = { type: "ephemeral", ttl: "1h" };
const FIVE = { type: "ephemeral", ttl: "5m" };
const mark = (m: ModelMessage, cc: unknown): ModelMessage => ({ ...m, providerOptions: { anthropic: { cacheControl: cc } } } as ModelMessage);
const markOf = (m: ModelMessage | undefined) => (m?.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl ?? null;
const user = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });
const reply = (text: string, calls: string[] = []): ModelMessage => ({
  role: "assistant",
  content: [{ type: "text", text }, ...calls.map((id) => ({ type: "tool-call" as const, toolCallId: id, toolName: "read", input: { path: `notes/${id}.md` } }))]
});
const result = (id: string, value: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value } }] });

const tools = { read: tool({ description: "Reads a file.", inputSchema: z.object({ path: z.string() }) }) };
const system = { role: "system" as const, content: "You manage the project-1 release.", providerOptions: { anthropic: { cacheControl: HOUR } } };
const callOptions = { providerOptions: {}, headers: { "x-session-id": "thr_a" }, reasoning: "high" };

test("a seal is the prompt through the last reply, marked for an hour, with a pending result for each of its tool calls", () => {
  const sealed = sealMessages([mark(user("Draft the notes"), FIVE), reply("Reading both.", ["c1", "c2"]), result("c1", "ok")])!;
  expect(sealed.sealedCount).toBe(2);
  expect(sealed.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(sealed.messages.map(markOf)).toEqual([null, HOUR, null]);
  expect(sealed.messages[2]!.content).toEqual([
    { type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "(pending)" } },
    { type: "tool-result", toolCallId: "c2", toolName: "read", output: { type: "text", value: "(pending)" } }
  ]);
});

test("after a reply with no tool calls, a user message with a dot", () => {
  const sealed = sealMessages([user("Draft the notes"), reply("Done: the notes are in the canvas.")])!;
  expect(sealed.messages.slice(-2).map(markOf)).toEqual([HOUR, null]);
  expect(sealed.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "." }] });
  expect(sealed.sealedCount).toBe(2);
});

test("no assistant message, no seal", () => {
  expect(sealMessages([user("Draft the notes")])).toBeNull();
});

// What comes after the sealed reply (its tool's result, a runtime-context
// message, the user's next message) and the marks do not change the
// fingerprint of the sealed part.
test("the fingerprint ignores marks and what follows the sealed part", async () => {
  const history = [user("Draft the notes"), reply("Reading it.", ["c1"])];
  const sealed = sealMessages(history)!;
  const next = [mark(user("Draft the notes"), FIVE), reply("Reading it.", ["c1"]), result("c1", "the changelog"), user("[Runtime context] 15:04"), mark(user("Also add the date"), FIVE)];
  const of = (messages: ModelMessage[]) => sealFingerprint({ system, tools, callOptions, messages, count: sealed.sealedCount });
  expect(await of(sealed.messages)).toBe(await of(next));
});

test("the fingerprint changes with the system, a tool's schema, the effort or a sealed message", async () => {
  const messages = [user("Draft the notes"), reply("Reading it.", ["c1"])];
  const base = { system, tools, callOptions, messages, count: 2 };
  const fp = await sealFingerprint(base);
  const others = await Promise.all([
    sealFingerprint({ ...base, system: { ...system, content: "You manage the project-2 release." } }),
    sealFingerprint({ ...base, tools: { read: tool({ description: "Reads a file.", inputSchema: z.object({ path: z.string(), lines: z.number() }) }) } }),
    sealFingerprint({ ...base, callOptions: { ...callOptions, reasoning: "low" } }),
    sealFingerprint({ ...base, messages: [user("Draft the notes!"), messages[1]!] })
  ]);
  for (const other of others) expect(other).not.toBe(fp);
});

test("layer 1: more than 16 output tokens is output; an hour-long write passes; no write is neutral; a five-minute or unreported write is short", () => {
  expect(judgeSealWrite({ outputTokens: 17, cacheWriteTokens: 50, cacheWrite1h: 50 })).toBe("output");
  expect(judgeSealWrite({ outputTokens: 16, cacheWriteTokens: 53, cacheWrite1h: 53 })).toBe("pass");
  expect(judgeSealWrite({ outputTokens: 1, cacheWriteTokens: 53, cacheWrite1h: 53 })).toBe("pass");
  expect(judgeSealWrite({ outputTokens: 1, cacheWriteTokens: 0, cacheWrite1h: undefined })).toBe("neutral");
  expect(judgeSealWrite({ outputTokens: 1, cacheWriteTokens: 53, cacheWrite1h: 0 })).toBe("short_write");
  expect(judgeSealWrite({ outputTokens: 1, cacheWriteTokens: 53, cacheWrite1h: undefined })).toBe("short_write");
});

test("layer 2: excused first, then the fingerprint, then the read inside 5-60 minutes", () => {
  const same = { sealedFingerprint: "a", stepFingerprint: "a", excused: false, sealedTokens: 20_000 };
  expect(judgeNextStep({ ...same, stepFingerprint: "b", excused: true, gapMs: 400_000, cacheReadTokens: 0 })).toBe("excused");
  expect(judgeNextStep({ ...same, stepFingerprint: "b", gapMs: 400_000, cacheReadTokens: 20_000 })).toBe("prefix_changed");
  expect(judgeNextStep({ ...same, gapMs: 400_000, cacheReadTokens: 15_000 })).toBe("not_read");
  expect(judgeNextStep({ ...same, gapMs: 400_000, cacheReadTokens: 16_000 })).toBe("pass");
  expect(judgeNextStep({ ...same, gapMs: 300_000, cacheReadTokens: 0 })).toBe("not_read");
  expect(judgeNextStep({ ...same, gapMs: 3_600_000, cacheReadTokens: 0 })).toBe("not_read");
  expect(judgeNextStep({ ...same, gapMs: 200_000, cacheReadTokens: 0 })).toBe("pass");
  expect(judgeNextStep({ ...same, gapMs: 4_000_000, cacheReadTokens: 0 })).toBe("pass");
});

test("Claude 5.5 takes part; a fixed-budget Claude, an unknown id with reasoning on, or another family does not; reasoning off takes part", () => {
  const takes = (meta: Record<string, unknown>) => sealParticipates({ meta } as never);
  expect(takes({ provider: "anthropic", model: "anthropic/claude-sonnet-5-5" })).toBe(true);
  expect(takes({ provider: "anthropic", model: "anthropic/claude-opus-5.5" })).toBe(true);
  expect(takes({ provider: "anthropic", model: "anthropic/claude-sonnet-4-5" })).toBe(false);
  expect(takes({ provider: "anthropic", model: "vendor/some-alias" })).toBe(false);
  expect(takes({ provider: "anthropic", model: "vendor/some-alias", supportsReasoning: false })).toBe(true);
  expect(takes({ provider: "openai-compatible", model: "anthropic/claude-sonnet-5-5" })).toBe(false);
});
