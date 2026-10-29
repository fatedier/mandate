import { afterEach, expect, test } from "bun:test";
import { mount } from "../helpers/mount.js";
import { runCleanups } from "../helpers/cleanup.js";
import type { AgentMessage } from "@/store/agent-chat";
import { causeForTriggerMessage, triggerReason } from "@/routes/window/chat/chatProvenance";
import { ChatProvenanceLine } from "@/routes/window/chat/ChatProvenanceLine";
import { pairWakeCauses } from "@/routes/window/chat/wake-causes";
import { threadNoticeMetadata, type ThreadNotice } from "@shared/thread-notice";

afterEach(() => { runCleanups(); });

const notice: ThreadNotice = { handoffIds: ["hof_1"], kind: "thread", targetThreadId: "thr_1", featureId: null, title: "Search timeout", stop: "stopped", reason: null };
const message = (over: Partial<AgentMessage> = {}, n: ThreadNotice = notice): AgentMessage => ({
  id: "m1", seq: 1, threadId: "g", role: "user", source: "thread-notice", sourceThreadId: "thr_1", wakeId: null,
  wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-12T06:52:00.000Z",
  content: { type: "text", text: "[Thread notice] …", metadata: threadNoticeMetadata(n) }, ...over
} as unknown as AgentMessage);
const noPane = () => null;

test("a notice is its wake's cause: the thread's name, where it is, whose reply it brought, and how it stopped", () => {
  expect(triggerReason(message())).toBe("thread-notice");
  const cause = causeForTriggerMessage(message(), noPane)!;
  expect([cause.subject?.text, cause.subject?.href, cause.label]).toEqual(["Search timeout", "/threads/thr_1", "stopped"]);
  expect(cause.subject?.reply).toEqual({ handoffIds: ["hof_1"], kind: "thread", stop: "stopped" });
  const { host } = mount(<ChatProvenanceLine provenance={cause} />, { path: "/agent" });
  // The name opens what the thread said: a button, and nothing on the line leaves the page.
  const name = host.querySelector('[data-slot="notice-name"]')!;
  expect([name.tagName, name.textContent, name.getAttribute("href")]).toEqual(["BUTTON", "Search timeout", null]);
  expect(host.querySelectorAll("a").length).toBe(0);
  expect(host.querySelector('[data-slot="provenance-label"]')!.textContent).toBe("Search timeout · stopped");
});

test("a notice that names no record keeps its name a link: there is no reply to open", () => {
  const cause = causeForTriggerMessage(message({}, { ...notice, handoffIds: [] }), noPane)!;
  expect([cause.subject?.href, cause.subject?.reply]).toEqual(["/threads/thr_1", undefined]);
  const { host } = mount(<ChatProvenanceLine provenance={cause} />, { path: "/agent" });
  const link = host.querySelector('[data-slot="provenance-link"]')!;
  expect([link.tagName, link.textContent, link.getAttribute("href")]).toEqual(["A", "Search timeout", "/threads/thr_1"]);
  expect(host.querySelector('[data-slot="notice-name"]') === null).toBe(true);
});

test("each way of stopping has its words; a worker's notice opens the worker's chat; an archived target has no link", () => {
  const label = (stop: ThreadNotice["stop"]) => causeForTriggerMessage(message({}, { ...notice, stop }), noPane)!.label;
  expect((["failed", "needs_you", "stopped", "archived"] as const).map(label)).toEqual(["failed", "needs you", "stopped", "archived"]);
  const worker = causeForTriggerMessage(message({}, { ...notice, kind: "feature", featureId: "feat_1", title: "login", stop: "needs_you" }), noPane, (id) => `/w/${id}`)!;
  expect([worker.subject?.text, worker.subject?.href]).toEqual(["login", "/w/feat_1"]);
  expect(worker.subject?.reply).toEqual({ handoffIds: ["hof_1"], kind: "feature", stop: "needs_you" });
  // A worker that is not among the projects (archived, say) is named, not linked.
  const unknown = causeForTriggerMessage(message({}, { ...notice, kind: "feature", featureId: "feat_1", title: "login" }), noPane, () => null)!;
  expect([unknown.subject?.text, unknown.subject?.href, unknown.subject?.reply]).toEqual(["login", undefined, undefined]);
  const gone = causeForTriggerMessage(message({}, { ...notice, stop: "archived", reason: "the thread was archived" }), noPane)!;
  expect([gone.subject?.href, gone.subject?.reply, gone.detail]).toEqual([undefined, undefined, "the thread was archived"]);
});

test("a round the user drove directly is a line with what it left: a result to read or a decision, its name a link to the thread", () => {
  const direct = (verdict: "result" | "decision") => causeForTriggerMessage(message({}, { ...notice, handoffIds: [], stop: "stopped", verdict, direct: true }), noPane)!;
  expect([direct("result").label, direct("decision").label]).toEqual(["result to read", "decision needed"]);
  expect([direct("result").subject?.href, direct("result").subject?.reply]).toEqual(["/threads/thr_1", undefined]);
  // So does what came after the agent's request was answered.
  const after = causeForTriggerMessage(message({}, { ...notice, handoffIds: [], stop: "stopped", verdict: "decision", after: true }), noPane)!;
  expect([after.label, after.subject?.href]).toEqual(["decision needed", "/threads/thr_1"]);
});

test("a question a followed thread asked is a line with the question; its name is a plain link, for the wait has not ended", () => {
  const asked: ThreadNotice = { ...notice, stop: "asked", question: { text: "Push fix/evict-order and open a pull request?", options: [{ label: "Push and open the PR" }, { label: "Hold it" }] } };
  const cause = causeForTriggerMessage(message({}, asked), noPane)!;
  expect([cause.subject?.text, cause.subject?.href, cause.label, cause.detail]).toEqual(["Search timeout", "/threads/thr_1", "asked a question", "Push fix/evict-order and open a pull request?"]);
  // No reply to open: the name leaves for the thread, where the question is answered.
  expect(cause.subject?.reply).toBeUndefined();
  const { host } = mount(<ChatProvenanceLine provenance={cause} />, { path: "/agent" });
  const link = host.querySelector('[data-slot="provenance-link"]')!;
  expect([link.tagName, link.textContent, link.getAttribute("href")]).toEqual(["A", "Search timeout", "/threads/thr_1"]);
  expect(host.querySelector('[data-slot="notice-name"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="provenance-label"]')!.textContent).toBe("Search timeout · asked a question");
});

test("a cause with no link draws its subject as text, as before", () => {
  const cause = causeForTriggerMessage(message({}, { ...notice, stop: "archived" }), noPane)!;
  const { host } = mount(<ChatProvenanceLine provenance={cause} />, { path: "/agent" });
  expect(host.querySelector('[data-slot="provenance-link"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="provenance-label"]')!.textContent).toBe("Search timeout · archived");
});

test("a message that says it is a notice but carries none draws nothing", () => {
  expect(causeForTriggerMessage(message({ content: { type: "text", text: "[Thread notice] …" } }), noPane)).toBeNull();
});

const reply = (id: string, seq: number, wakeId: string): AgentMessage => ({
  id, seq, threadId: "g", role: "assistant", source: "self", sourceThreadId: null, wakeId,
  wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-12T06:52:01.000Z",
  content: { type: "assistant", text: "Looking.", toolCalls: [] }
} as unknown as AgentMessage);

test("a notice rides on the reply of the turn it woke, as an alarm does", () => {
  const rows = [
    { kind: "msg" as const, message: message({ id: "n1", seq: 1 }) },
    { kind: "msg" as const, message: reply("a1", 2, "w_notice") }
  ];
  const paired = pairWakeCauses(rows, () => "thread-notice");
  expect(paired.map((row) => [row.message.id, row.cause?.id ?? null])).toEqual([["a1", "n1"]]);
});

// A notice taken between the steps of a turn that was already
// talking is not that turn's cause; it stays a line of its own.
test("a notice that lands in the middle of a turn already under way stays a line on its own", () => {
  const rows = [
    { kind: "msg" as const, message: reply("a1", 1, "w_user") },
    { kind: "msg" as const, message: message({ id: "n1", seq: 2 }) },
    { kind: "msg" as const, message: reply("a2", 3, "w_user") }
  ];
  const paired = pairWakeCauses(rows, () => "user");
  expect(paired.map((row) => [row.message.id, row.cause?.id ?? null])).toEqual([["a1", null], ["n1", null], ["a2", null]]);
});

test("a question settled in the thread is a line with the question; its name is a plain link, for no wait ended", () => {
  const settled: ThreadNotice = {
    ...notice, handoffIds: [], stop: "settled",
    question: { id: "q_1", text: "Push fix/evict-order and open a pull request?", options: [] },
    settled: { how: "answered", answer: "Push and open the PR" }
  };
  const cause = causeForTriggerMessage(message({}, settled), noPane)!;
  expect([cause.subject?.text, cause.subject?.href, cause.subject?.reply, cause.label, cause.detail])
    .toEqual(["Search timeout", "/threads/thr_1", undefined, "question settled", "Push fix/evict-order and open a pull request?"]);
  const { host } = mount(<ChatProvenanceLine provenance={cause} />, { path: "/agent" });
  expect(host.querySelector('[data-slot="provenance-label"]')!.textContent).toBe("Search timeout · question settled");
});
