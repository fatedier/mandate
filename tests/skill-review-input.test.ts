import { expect, test } from "bun:test";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import { estimateTextTokens } from "../src/server/modules/agent/compression.js";
import { renderReviewOpening, renderTranscript, REVIEW_OPENING_BUDGET_TOKENS, type ReviewOpeningInput } from "../src/server/modules/skills/skill-review-input.js";

let seq = 0;
function msg(role: AgentMessage["role"], source: AgentMessage["source"], content: AgentMessage["content"]): AgentMessage {
  seq += 1;
  return { id: `msg_${seq}`, threadId: "thr_w", seq, role, source, sourceThreadId: null, wakeId: null, content, createdAt: "2026-11-16T10:00:00.000Z" } as AgentMessage;
}
const user = (text: string) => msg("user", "user", { type: "text", text });
const call = (toolName: string, args: unknown, text?: string) => msg("assistant", "self", { type: "assistant", ...(text ? { text } : {}), toolCalls: [{ toolCallId: `c${seq + 1}`, toolName, args }] } as AgentMessage["content"]);
const result = (toolName: string, value: unknown) => msg("tool", "self", { type: "tool_result", toolCallId: `c${seq}`, toolName, result: value } as AgentMessage["content"]);
const failed = (toolName: string, error: string) => msg("tool", "self", { type: "tool_result", toolCallId: `c${seq}`, toolName, isError: true, error } as AgentMessage["content"]);
const reply = (text: string) => msg("assistant", "self", { type: "assistant", text });

function input(messages: AgentMessage[], over: Partial<ReviewOpeningInput> = {}): ReviewOpeningInput {
  return {
    conversation: { threadId: "thr_w", title: "cert renewal", kind: "worker", workerName: "cert renewal", projectNames: ["bakery"] },
    requestedBy: "Bakery",
    focus: "the renewal order that worked",
    fromSeq: messages[0]!.seq,
    toSeq: messages.at(-1)!.seq,
    messages,
    subagents: [{ threadId: "thr_sub", title: "check the oven" }],
    skills: [{ name: "cert-renewal", description: "Renew the shop's certificates.", where: "project bakery", status: "available", revision: 3, uses90: 4, lastUsedAt: "2026-11-10T08:00:00.000Z" }],
    ...over
  };
}

test("the opening holds the range, cut results, the skills in reach and the focus", () => {
  seq = 0;
  const long = "x".repeat(5_000);
  const messages = [user("Renew the certificates."), call("bash", { command: "certbot renew" }, "Renewing."), result("bash", long), failed("bash", "exit 1"), reply("Renewed after a reload.")];
  const opening = renderReviewOpening(input(messages));
  expect(opening).toContain("the renewal order that worked");
  expect(opening).toContain("Bakery");
  expect(opening).toContain("thr_w");
  expect(opening).toContain("#1 user: Renew the certificates.");
  expect(opening).toContain('#2 agent called bash {"command":"certbot renew"}');
  expect(opening).toContain(`#3 result of bash: ${"x".repeat(2_000)}`);
  expect(opening).not.toContain("x".repeat(2_001));
  expect(opening).toContain("3,000 more characters");
  expect(opening).toContain("#4 result of bash: error: exit 1");
  expect(opening).toContain("#5 agent: Renewed after a reload.");
  expect(opening).toContain("check the oven");
  expect(opening).toContain("thr_sub");
  expect(opening).toContain("- cert-renewal (project bakery, available, revision 3; 4 uses in 90 days, last used 2026-11-10): Renew the shop's certificates.");
});

test("past 40,000 tokens the middle turns are one line each, the request and the last turns whole, and it says where", () => {
  seq = 0;
  const messages = [user("Renew the certificates on every node.")];
  for (let i = 0; i < 150; i++) messages.push(call("bash", { command: `step ${i}` }), result("bash", `output ${i} `.repeat(200)));
  messages.push(reply("All nodes renewed; the reload order was the fix."));
  const opening = renderReviewOpening(input(messages));
  expect(estimateTextTokens(opening)).toBeLessThanOrEqual(REVIEW_OPENING_BUDGET_TOKENS);
  expect(opening).toContain("#1 user: Renew the certificates on every node.");
  expect(opening).toContain(`#${seq} agent: All nodes renewed; the reload order was the fix.`);
  // The last result is whole (within its cut); an early one is one line.
  expect(opening).toContain(`#${seq - 1} result of bash: output 149 output 149`);
  expect(opening).toContain("#3 result of bash: ok");
  expect(opening).toMatch(/Shortened: messages 2 to \d+ are one line each here\./);
});

test("no skills in reach says so", () => {
  seq = 0;
  expect(renderReviewOpening(input([user("Hi.")], { skills: [], subagents: [] }))).toContain("Learned skills you may change: none yet.");
});

test("a transcript page holds results up to 20,000 characters and says where it goes on", () => {
  seq = 0;
  const messages = [user("Go."), call("read", { path: "a" }), result("read", "y".repeat(25_000)), reply("Done.")];
  const whole = renderTranscript(messages, { resultChars: 20_000, pageChars: 100_000 });
  expect(whole.text).toContain("y".repeat(20_000));
  expect(whole.text).not.toContain("y".repeat(20_001));
  expect(whole.nextSeq).toBeNull();
  const paged = renderTranscript(messages, { resultChars: 20_000, pageChars: 1_000 });
  expect(paged.text).toContain("#2 agent called read");
  expect(paged.text).not.toContain("#4 agent: Done.");
  expect(paged.nextSeq).toBe(3);
});

test("a message too long for a page is cut, and neither a page nor the opening passes its size", () => {
  seq = 0;
  const pasted = user(`log ${"z".repeat(260_000)}`);
  const done = reply("Read it.");
  const page = renderTranscript([pasted, done], { resultChars: 20_000, pageChars: 60_000 });
  expect(page.text.length).toBeLessThanOrEqual(60_000);
  expect(page.text.includes("more characters cut")).toBe(true);
  const opening = renderReviewOpening(input([pasted, done]));
  expect(estimateTextTokens(opening)).toBeLessThanOrEqual(REVIEW_OPENING_BUDGET_TOKENS);
  expect(opening.includes("#2 agent: Read it.")).toBe(true);
});

test("a cut never splits a character in two", () => {
  seq = 0;
  // 20,001 code units of two-unit characters: a cut at 20,000 falls inside one.
  const page = renderTranscript([user(`x${"😀".repeat(15_000)}`)], { resultChars: 20_000, pageChars: 60_000 });
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(page.text)).toBe(false);
});

test("a step with several long calls fits one transcript page whole, and the opening promises only what the transcript shows", () => {
  seq = 0;
  const step = (calls: number, chars: number) => msg("assistant", "self", { type: "assistant", toolCalls: Array.from({ length: calls }, (_, i) => ({ toolCallId: `w${i}`, toolName: "write", args: { path: `f${i}`, content: "c".repeat(chars) } })) } as AgentMessage["content"]);
  const four = step(4, 22_000);
  const page = renderTranscript([four], { resultChars: 20_000, pageChars: 60_000 });
  expect(page.text.length).toBeLessThanOrEqual(60_000);
  expect(page.text.split("agent called write").length - 1).toBe(4);
  const opening = renderReviewOpening(input([user("Write them."), four]));
  expect(opening.split("read_transcript shows more").length - 1).toBe(4);
  // So many calls that the transcript shows no more of each than the opening does.
  seq = 0;
  const many = step(30, 3_000);
  expect(renderReviewOpening(input([user("Write them."), many])).includes("read_transcript shows more")).toBe(false);
});

test("a step at the text cap with many calls still fits one page with every call", () => {
  seq = 0;
  const calls = 60;
  const big = msg("assistant", "self", { type: "assistant", text: "t".repeat(25_000), toolCalls: Array.from({ length: calls }, (_, i) => ({ toolCallId: `w${i}`, toolName: "write_a_rather_long_tool_name", args: { path: `f${i}`, content: "c".repeat(3_000) } })) } as AgentMessage["content"]);
  const page = renderTranscript([big], { resultChars: 20_000, pageChars: 60_000 });
  expect(page.text.length).toBeLessThanOrEqual(60_000);
  expect(page.text.split("agent called write_a_rather_long_tool_name").length - 1).toBe(calls);
  // A small page with a few calls: each still has its line.
  seq = 0;
  const few = msg("assistant", "self", { type: "assistant", toolCalls: Array.from({ length: 7 }, (_, i) => ({ toolCallId: `s${i}`, toolName: "write", args: { content: "d".repeat(400) } })) } as AgentMessage["content"]);
  const small = renderTranscript([few], { resultChars: 20_000, pageChars: 1_000 });
  expect(small.text.length).toBeLessThanOrEqual(1_000);
  expect(small.text.split("agent called write").length - 1).toBe(7);
});
