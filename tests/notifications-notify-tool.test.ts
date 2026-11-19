import { expect, test } from "bun:test";
import { buildNotifyTool } from "../src/server/modules/notifications/notify-tool.js";
import type { NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { stub, toolContext } from "./helpers/typed.js";

// The personal agent tells the user something outside its conversation with
// `notify`; nobody else has it.

type Thread = { id: string; archivedAt: string | null; scope: string };

function tool(options: { line?: string; notSent?: "channel"; threads?: Record<string, Thread>; workers?: Record<string, { id: string; ownerThreadId: string | null }> } = {}) {
  const seen: NotifyRequest[] = [];
  const notify = buildNotifyTool({
    service: { notify: async (request) => { seen.push(request); return { line: options.line ?? "Sent to: Phone.", ...(options.notSent ? { notSent: options.notSent } : {}) }; } },
    agentStore: { getThreadById: (id: string) => (options.threads?.[id] ?? null) as never },
    workersStore: { getById: (id: string) => (options.workers?.[id] ?? null) as never }
  });
  const call = (args: Record<string, unknown>) => notify.handler(args as never, toolContext());
  return { notify, call, seen };
}

const base = { title: "Login fix needs your call", text: "The manager asks whether the migration test may use staging." };

test("notify is in the personal agent's tools and in no other scope's, subagents included", () => {
  const env = freshStoresEnv("md-notify-scopes-");
  const runtime = testAgentRuntime(env, { notifications: stub({ notify: async () => ({ line: "Sent to: Phone." }), channelChoices: () => [] }) });
  try {
    const names = (scope: "personal" | "manager" | "worker" | "subagent") => runtime.scopes[scope].toolDefinitions.map((t) => t.name);
    expect(names("personal")).toContain("notify");
    expect(names("manager")).not.toContain("notify");
    expect(names("worker")).not.toContain("notify");
    expect(names("subagent")).not.toContain("notify");
  } finally {
    runtime.dispose();
  }
});

test("its description and its channels parameter's are word for word", () => {
  const notify = tool().notify;
  expect(notify.description).toBe("Tell the user something now, outside this conversation, on the channels they set up (a desktop notification, their phone). Unless you name channels, Mandate chooses from where the user is right now: nothing while they are already looking at it, their computer while they are at it, their phone when they are away or leave it unseen for a few minutes. On the computer, another call about the same thread or worker replaces the earlier notice; on the phone, each call is a new message.");
  const shape = (notify.parameters as unknown as { shape: Record<string, { description?: string }> }).shape;
  expect(shape.channels?.description).toBe("Channel names from \"Notification channels\" in your context. Leave this out and Mandate chooses: it knows whether the user is at their desk and what they are looking at, and you do not. Name channels only where the user has said they want to be told, in this conversation or as a standing preference. Named channels get it at once, wherever the user is, and keep it after the user has seen it.");
});

test("named channels go to the service trimmed; none named, or only blanks, is Mandate's choice", async () => {
  const t = tool();
  await t.call({ ...base, channels: [" Phone ", "Browser", ""] });
  await t.call({ ...base, channels: [] });
  await t.call({ ...base, channels: ["  "] });
  await t.call({ ...base, channels: null });
  expect(t.seen.map((r) => r.channels)).toEqual([["Phone", "Browser"], undefined, undefined, undefined]);
});

test("a channel it cannot name is an error, so the call shows as failed", async () => {
  const t = tool({ line: "No channel named \"Phon\". Channels: Browser, Phone.", notSent: "channel" });
  expect(await t.call({ ...base, channels: ["Phon"] })).toEqual({ error: "No channel named \"Phon\". Channels: Browser, Phone." });
});

test("a thread id makes a thread matter linked to its page", async () => {
  const t = tool({ threads: { thr_a: { id: "thr_a", archivedAt: null, scope: "manager" } } });
  expect(await t.call({ ...base, threadId: "thr_a" })).toEqual({ outcome: "Sent to: Phone." });
  expect(t.seen).toEqual([{ source: "agent", matter: { key: "thread:thr_a", link: "/threads/thr_a" }, title: base.title, text: base.text, level: "needs_you" }]);
});

test("a worker id links to its owner's page with ?worker; without an owner, Home", async () => {
  const t = tool({ workers: { wkr_w: { id: "wkr_w", ownerThreadId: "thr_a" }, wkr_lone: { id: "wkr_lone", ownerThreadId: null } } });
  await t.call({ ...base, workerId: "wkr_w", level: "news" });
  await t.call({ ...base, workerId: "wkr_lone" });
  expect(t.seen.map((r) => [r.matter, r.level])).toEqual([
    [{ key: "worker:wkr_w", link: "/threads/thr_a?worker=wkr_w" }, "news"],
    [{ key: "worker:wkr_lone", link: "/home" }, "needs_you"]
  ]);
});

test("no id makes a fresh agent matter each call; blank ids count as none", async () => {
  const t = tool();
  await t.call(base);
  await t.call({ ...base, threadId: "", workerId: null });
  const [a, b] = t.seen.map((r) => r.matter);
  expect(a!.key).toMatch(/^agent:/);
  expect(b!.key).toMatch(/^agent:/);
  expect(a!.key).not.toBe(b!.key);
  expect(a!.link).toBe("/agent");
});

test("both ids are refused", async () => {
  const t = tool({ threads: { thr_a: { id: "thr_a", archivedAt: null, scope: "manager" } }, workers: { wkr_w: { id: "wkr_w", ownerThreadId: "thr_a" } } });
  expect(await t.call({ ...base, threadId: "thr_a", workerId: "wkr_w" })).toEqual({ error: "Give at most one of threadId and workerId." });
  expect(t.seen).toStrictEqual([]);
});

test("an unknown or archived thread, or an unknown worker, is refused", async () => {
  const t = tool({ threads: { thr_old: { id: "thr_old", archivedAt: "2026-10-01T00:00:00.000Z", scope: "manager" } } });
  expect(await t.call({ ...base, threadId: "thr_none" })).toEqual({ error: "No open thread thr_none." });
  expect(await t.call({ ...base, threadId: "thr_old" })).toEqual({ error: "No open thread thr_old." });
  expect(await t.call({ ...base, workerId: "wkr_none" })).toEqual({ error: "No worker wkr_none." });
  expect(t.seen).toStrictEqual([]);
});

test("the outcome line is returned as is", async () => {
  const t = tool({ line: "Not sent: the user is looking at it." });
  expect(await t.call(base)).toEqual({ outcome: "Not sent: the user is looking at it." });
});
