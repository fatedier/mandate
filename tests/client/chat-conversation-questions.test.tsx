import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useProjectsStore, type Project } from "@/store/projects";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useVoiceStore } from "@/store/voice";
import type { AgentMessageDto, ManagerThreadDto } from "@shared/api/agents";
import type { GlobalAgentDto } from "@shared/api/global-agent";
import type { OpenQuestion } from "@shared/questions";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { fireAnimation, slotAnimating } from "../helpers/motion.js";
import { agentMessage, stub } from "../helpers/typed.js";

afterEach(() => {
  // Unmount before the stores the conversation reads are reset under it.
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useManagerThreadsStore.setState({ threads: new Map() });
  useGlobalAgentStore.setState({ agent: null });
  useVoiceStore.setState({ voiceMode: false, connectionState: "idle" });
  useProjectsStore.setState({ projects: [] });
  useWakeActivityStore.setState({ activeByFeatureId: new Map() });
});

// The question a manager asked stands where the user answers: above the
// composer of its thread, whatever the conversation has moved on to.

const AT = "2026-01-12T14:00:00.000Z";
const PUSH: OpenQuestion = {
  id: "q_1", askedAt: AT, question: "Push fix/evict-order and open a pull request?",
  options: [{ label: "Push and open the PR", description: "The tests pass." }, { label: "Hold it" }]
};

/** A thread whose manager asked PUSH, as its first page and its list entry say. */
function asked(threadId: string, questions: OpenQuestion[] = [PUSH]): AgentMessageDto[] {
  useManagerThreadsStore.setState({
    threads: new Map([[threadId, stub<ManagerThreadDto>({ id: threadId, title: "Eviction order", running: false, failed: false, stopReason: null, questions, archivedAt: null })]])
  });
  return [
    agentMessage({ id: "u1", threadId, seq: 1, content: { type: "text", text: "Fix the eviction order bug." } }),
    agentMessage({
      id: "a1", threadId, seq: 2, role: "assistant", wakeId: "w1",
      content: { type: "assistant", text: "The fix is in.", toolCalls: [{ toolCallId: "c1", toolName: "ask_user", args: { question: PUSH.question } }] }
    }),
    agentMessage({
      id: "t1", threadId, seq: 3, role: "tool", wakeId: "w1",
      content: { type: "tool_result", toolCallId: "c1", toolName: "ask_user", result: { asked: true, questionId: PUSH.id, question: PUSH.question, options: PUSH.options } }
    })
  ];
}
const page = (threadId: string, messages: AgentMessageDto[]) =>
  ({ thread: { id: threadId }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null });

async function render(scope: AgentChatScope, post: (call: FetchCall) => Response, messages: AgentMessageDto[], opens?: { onOpenWorker: (featureId: string) => void }) {
  const calls = mockFetch((call) => (call.method === "POST" ? post(call) : jsonResponse(page(scope.type === "worker" ? "" : scope.threadId, messages))));
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} {...opens} /></MemoryRouter>);
  await settle();
  return { host, posts: () => calls.filter((call) => call.method === "POST") };
}
const slot = (host: ParentNode, name: string) => host.querySelector<HTMLElement>(`[data-slot="${name}"]`);
const options = (host: ParentNode) => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="question-option"]')];

test("a manager's open question stands above its thread's composer, and its line in the conversation is open", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q1" };
  const { host } = await render(scope, () => jsonResponse({}), asked("t_q1"));
  expect(slot(host, "question-text")!.textContent).toBe(PUSH.question);
  expect(options(host).map((o) => o.querySelector('[data-slot="question-option-label"]')!.textContent)).toEqual(["Push and open the PR", "Hold it"]);
  // Above the composer: it comes first in the page.
  const dock = slot(host, "question-dock")!;
  expect(dock.compareDocumentPosition(host.querySelector("textarea")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(slot(host, "ask-line")!.dataset.state).toBe("open");
  // And said to a screen reader.
  expect(slot(host, "question-announcer")!.textContent).toBe(`Needs your answer: ${PUSH.question}`);
});

test("the thread's workers at work stand over the question, which stays nearest the composer; a worker's own chat has no strip", async () => {
  // One worker of t_q5, running a turn.
  useProjectsStore.setState({ projects: [stub<Project>({ id: "p1", name: "project-1", tmuxSessionName: "project-1", features: [stub<Project["features"][number]>({ id: "f1", name: "evict-order", tmuxWindowName: "evict-order", ownerThreadId: "t_q5" })] })] });
  useWakeActivityStore.setState({ activeByFeatureId: new Map([["f1", { wakeId: "wf1", startedAt: AT }]]) });
  const opened: string[] = [];
  const opens = { onOpenWorker: (featureId: string) => opened.push(featureId) };
  const { host } = await render({ type: "manager", threadId: "t_q5" }, () => jsonResponse({}), asked("t_q5"), opens);
  const strip = slot(host, "worker-strip")!;
  expect(slot(strip, "worker-strip-text")!.textContent).toBe("evict-order · Working…");
  expect(strip.compareDocumentPosition(slot(host, "question-dock")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Its row opens the worker, through the page.
  await act(async () => { slot(strip, "worker-strip-row")!.click(); });
  expect(opened).toStrictEqual(["f1"]);
  // The worker stops while an answer is half typed: the strip goes, the question and its words stay.
  const input = slot(host, "question-input") as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, "Push it later today.");
    input.dispatchEvent(new (input.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
  });
  act(() => { useWakeActivityStore.setState({ activeByFeatureId: new Map() }); });
  await settle();
  expect(slot(host, "worker-strip") === null).toBe(true);
  expect(slot(host, "question-input") === input).toBe(true);
  expect(input.value).toBe("Push it later today.");
  runCleanups();
  const worker = await render({ type: "worker", featureId: "f1" }, () => jsonResponse({}), [], opens);
  expect(slot(worker.host, "worker-strip") === null).toBe(true);
});

test("a thread with nothing open has only its composer, and what it once asked reads as answered", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q2" };
  const { host } = await render(scope, () => jsonResponse({}), asked("t_q2", []));
  expect(slot(host, "question-dock") === null).toBe(true);
  expect(slot(host, "ask-line")!.dataset.state).toBe("answered");
});

test("picking an answer sends it as the user's message, naming the question it answers", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q3" };
  const { host, posts } = await render(scope, () => jsonResponse({ threadId: "t_q3", messageId: "m9", wakeId: null }), asked("t_q3"));
  await act(async () => { options(host)[0]!.click(); });
  await settle();
  expect(posts().length).toBe(1);
  expect(posts()[0]!.url).toContain("t_q3");
  const body = JSON.parse(String(posts()[0]!.init!.body)) as { content: string; answers?: string[] };
  expect([body.content, body.answers]).toEqual(["Push and open the PR", ["q_1"]]);
  expect(slot(host, "question-error") === null).toBe(true);
});

test("a pick the server refuses says why by the question, and leaves no message of the user's behind", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q4" };
  const { host } = await render(scope, () => jsonResponse({ error: "That question is no longer open." }, 409), asked("t_q4"));
  await act(async () => { options(host)[1]!.click(); });
  await settle();
  expect(slot(host, "question-error")!.textContent).toBe("That question is no longer open.");
  expect(useAgentChatStore.getState().threadsByScope.get("manager:t_q4")!.pendingUserMessages.size).toBe(0);
  // What the user typed is another matter: it is not sent with the pick.
  expect(host.textContent).not.toContain("Hold itHold it");
});

test("an answer given from the question, once it is taken and the question goes, leaves the focus in the composer", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q7" };
  const { host } = await render(scope, () => jsonResponse({ threadId: "t_q7", messageId: "m9", wakeId: null }), asked("t_q7"));
  options(host)[0]!.focus();
  await act(async () => { options(host)[0]!.click(); });
  await settle();
  // The thread's event: nothing is open any more.
  act(() => { useManagerThreadsStore.getState().upsert({ ...useManagerThreadsStore.getState().threads.get("t_q7")!, questions: [] }); });
  await settle();
  expect(slot(host, "question-dock") === null).toBe(true);
  expect(document.activeElement === host.querySelector("textarea")).toBe(true);
});

test("a question asked later rises in over the composer; one there as the conversation opens is just there", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q20" };
  const { host } = await render(scope, () => jsonResponse({}), asked("t_q20"));
  const entering = () => slot(host, "question-dock")?.closest('[data-slot="shown"]')?.className.split(/\s+/).includes("animate-in") ?? null;
  expect(entering()).toBe(false);
  const thread = () => useManagerThreadsStore.getState().threads.get("t_q20")!;
  act(() => { useManagerThreadsStore.getState().upsert({ ...thread(), questions: [] }); });
  await settle();
  expect(entering()).toBeNull();
  act(() => { useManagerThreadsStore.getState().upsert({ ...thread(), questions: [{ ...PUSH, id: "q_2", question: "Tag 3.21 today?" }] }); });
  await settle();
  expect(entering()).toBe(true);
});

test("answered, the question fades out as it was, out of reach, with the focus already in the composer; then it is gone", async () => {
  slotAnimating("shown", (el) => (el.className.includes("animate-out") ? "exit" : "none"));
  const scope: AgentChatScope = { type: "manager", threadId: "t_q21" };
  const { host } = await render(scope, () => jsonResponse({ threadId: "t_q21", messageId: "m9", wakeId: null }), asked("t_q21"));
  options(host)[0]!.focus();
  await act(async () => { options(host)[0]!.click(); });
  await settle();
  act(() => { useManagerThreadsStore.getState().upsert({ ...useManagerThreadsStore.getState().threads.get("t_q21")!, questions: [] }); });
  await settle();
  const leaving = slot(host, "question-dock")!.closest<HTMLElement>('[data-slot="shown"]')!;
  expect([leaving.textContent?.includes(PUSH.question), leaving.inert, document.activeElement === host.querySelector("textarea")]).toEqual([true, true, true]);
  fireAnimation(leaving, "animationend", "exit");
  await settle();
  expect([slot(host, "question-dock") === null, host.querySelector('[data-slot="shown"]') === null, document.activeElement === host.querySelector("textarea")]).toEqual([true, true, true]);
});

test("a question that closes while the conversation is still loading leaves nothing above the composer", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q22" };
  const messages = asked("t_q22");
  let deliver: () => void = () => {};
  const arrived = new Promise<void>((resolve) => { deliver = resolve; });
  mockFetch(async () => { await arrived; return jsonResponse(page("t_q22", messages)); });
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  // Answered elsewhere before the first page is here.
  act(() => { useManagerThreadsStore.getState().upsert({ ...useManagerThreadsStore.getState().threads.get("t_q22")!, questions: [] }); });
  await settle();
  deliver();
  await settle();
  await settle();
  // The composer's box lays out as with nothing above it: it does not shrink.
  const box = host.querySelector("textarea")!.closest<HTMLElement>('[class*="scrollbar-gutter:stable"]')!;
  expect([slot(host, "question-dock") === null, box.classList.contains("shrink-0")]).toEqual([true, true]);
});

test("on the agent's page the composer is focused once for the last answer: drawn again when voice gives its place back, it is not", async () => {
  const scope: AgentChatScope = { type: "global", threadId: "t_g7" };
  const messages = asked("t_g7");
  useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "t_g7", name: "", voiceConfigured: false, questions: [PUSH] }) });
  const { host } = await render(scope, () => jsonResponse({ threadId: "t_g7", messageId: "m9", wakeId: null }), messages);
  options(host)[0]!.focus();
  await act(async () => { options(host)[0]!.click(); });
  await settle();
  await act(async () => { useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "t_g7", name: "", voiceConfigured: false, questions: [] }) }); });
  await settle();
  expect(document.activeElement === host.querySelector("textarea")).toBe(true);
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    act(() => { elsewhere.focus(); });
    await act(async () => { useVoiceStore.setState({ voiceMode: true, connectionState: "moved" }); });
    expect(host.querySelector("textarea") === null).toBe(true);
    await act(async () => { useVoiceStore.setState({ voiceMode: false, connectionState: "idle" }); });
    await settle();
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(document.activeElement === elsewhere).toBe(true);
  } finally { elsewhere.remove(); }
});

test("an answer refused because its question closed elsewhere reads the thread again, and the question goes", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q6" };
  const messages = asked("t_q6");
  const calls = mockFetch((call) => {
    if (call.method === "POST") return jsonResponse({ error: "That question is no longer open." }, 409);
    // The list, read again: the thread no longer asks.
    if (call.url.endsWith("/api/agents/manager/threads")) {
      return jsonResponse({ threads: [stub<ManagerThreadDto>({ id: "t_q6", title: "Eviction order", running: false, failed: false, stopReason: null, questions: [], archivedAt: null })] });
    }
    return jsonResponse(page("t_q6", messages));
  });
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  await settle();
  await act(async () => { options(host)[0]!.click(); });
  await settle();
  expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/agents/manager/threads")).length).toBe(1);
  expect(slot(host, "question-dock") === null).toBe(true);
});

test("on the agent's page too, a refused answer reads the agent again, and the question goes", async () => {
  const scope: AgentChatScope = { type: "global", threadId: "t_g6" };
  const messages = asked("t_g6");
  useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "t_g6", name: "", voiceConfigured: false, questions: [PUSH] }) });
  const calls = mockFetch((call) => {
    if (call.method === "POST") return jsonResponse({ error: "That question is no longer open." }, 409);
    if (call.url.endsWith("/api/agents/global")) return jsonResponse({ agent: stub<GlobalAgentDto>({ threadId: "t_g6", name: "", voiceConfigured: false, questions: [] }) });
    return jsonResponse(page("t_g6", messages));
  });
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  await settle();
  await act(async () => { options(host)[0]!.click(); });
  await settle();
  expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/agents/global")).length).toBe(1);
  expect(slot(host, "question-dock") === null).toBe(true);
});

test("the agent's own question stands on its page, and stays when voice has taken the composer's place", async () => {
  const scope: AgentChatScope = { type: "global", threadId: "t_g1" };
  const messages = asked("t_g1");
  useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "t_g1", name: "", voiceConfigured: false, questions: [PUSH] }) });
  const { host } = await render(scope, () => jsonResponse({}), messages);
  expect(slot(host, "question-text")!.textContent).toBe(PUSH.question);
  expect(slot(host, "ask-line")!.dataset.state).toBe("open");
  // Voice went to another device: no composer here, the question still above what stands in its place.
  await act(async () => { useVoiceStore.setState({ voiceMode: true, connectionState: "moved" }); });
  expect(host.querySelector("textarea") === null).toBe(true);
  const moved = slot(host, "voice-moved")!;
  expect(slot(host, "question-dock")!.compareDocumentPosition(moved) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Another conversation's questions are not this one's.
  await act(async () => { useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "t_other", name: "", voiceConfigured: false, questions: [PUSH] }) }); });
  expect(slot(host, "question-dock") === null).toBe(true);
});

test("an answer picked while voice has the composer's place stays held when the composer comes back", async () => {
  const scope: AgentChatScope = { type: "global", threadId: "t_g2" };
  const messages = asked("t_g2");
  useGlobalAgentStore.setState({ agent: stub<GlobalAgentDto>({ threadId: "t_g2", name: "", voiceConfigured: false, questions: [PUSH] }) });
  useVoiceStore.setState({ voiceMode: true, connectionState: "moved" });
  // The pick is on its way and stays there.
  const { host, posts } = await render(scope, () => new Promise<Response>(() => {}) as unknown as Response, messages);
  await act(async () => { options(host)[0]!.click(); });
  expect(options(host).map((o) => o.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
  // Voice ends: the question now stands over the composer, its answers still held.
  await act(async () => { useVoiceStore.setState({ voiceMode: false, connectionState: "idle" }); });
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(options(host).map((o) => o.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
  await act(async () => { options(host)[1]!.click(); });
  expect(posts().length).toBe(1);
});

test("Continue under a turn that stopped at its limit is sent as the control's, so the question the turn asked still stands", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_q7" };
  const messages = [
    ...asked("t_q7"),
    agentMessage({
      id: "f1", threadId: "t_q7", seq: 4, role: "system", source: "wake-failure", wakeId: "w1",
      content: { type: "wake_failure", status: "limit_reached", message: null, stepCount: 60 } as never
    })
  ];
  const { host, posts } = await render(scope, () => jsonResponse({ threadId: "t_q7", messageId: "m9", wakeId: "w2" }), messages);
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === "Continue")!;
  await act(async () => { button.click(); });
  await settle();
  const body = JSON.parse(String(posts()[0]!.init!.body)) as { content: string; control?: string; answers?: string[] };
  expect([body.content, body.control, body.answers]).toEqual(["Continue", "continue", undefined]);
});


test("Skip sends the skip for that question and no message of the user's; once the question goes, the focus is in the composer", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_s1" };
  const { host, posts } = await render(scope, () => jsonResponse({ ok: true }), asked("t_s1"));
  const skip = slot(host, "question-skip")!;
  skip.focus();
  await act(async () => { skip.click(); });
  await settle();
  expect(posts().map((p) => p.url)).toEqual(["/api/agents/threads/t_s1/questions/q_1/skip"]);
  expect(useAgentChatStore.getState().threadsByScope.get("manager:t_s1")!.pendingUserMessages.size).toBe(0);
  act(() => { useManagerThreadsStore.getState().upsert({ ...useManagerThreadsStore.getState().threads.get("t_s1")!, questions: [] }); });
  await settle();
  expect(slot(host, "question-dock") === null).toBe(true);
  expect(document.activeElement === host.querySelector("textarea")).toBe(true);
});

test("a skip refused because the question closed elsewhere says why, and reads the thread again", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_s2" };
  const messages = asked("t_s2");
  const calls = mockFetch((call) => {
    if (call.method === "POST") return jsonResponse({ error: "That question is no longer open." }, 409);
    if (call.url.endsWith("/api/agents/manager/threads")) {
      return jsonResponse({ threads: [stub<ManagerThreadDto>({ id: "t_s2", title: "Eviction order", running: false, failed: false, stopReason: null, questions: [PUSH], archivedAt: null })] });
    }
    return jsonResponse(page("t_s2", messages));
  });
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  await settle();
  await act(async () => { slot(host, "question-skip")!.click(); });
  await settle();
  expect(slot(host, "question-error")!.textContent).toBe("That question is no longer open.");
  expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/agents/manager/threads")).length).toBe(1);
});

test("a question the user skipped reads as skipped on its line, and the skip itself is no row of the conversation", async () => {
  const scope: AgentChatScope = { type: "manager", threadId: "t_s3" };
  const messages = [
    ...asked("t_s3", []),
    agentMessage({ id: "s1", threadId: "t_s3", seq: 4, source: "question-skip", content: { type: "text", text: `The user skipped your question "${PUSH.question}".`, metadata: { closedQuestions: ["q_1"] } } })
  ];
  const { host } = await render(scope, () => jsonResponse({}), messages);
  const line = slot(host, "ask-line")!;
  expect([line.dataset.state, slot(line, "ask-line-label")!.textContent]).toEqual(["skipped", "Asked you · skipped"]);
  expect(host.textContent).not.toContain("The user skipped your question");
});
