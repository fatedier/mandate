import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { AgentMessageDto } from "@shared/api/agents";
import { mentionsMetadata } from "@shared/mentions";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { agentMessage } from "../helpers/typed.js";
import { managerThreadDto } from "../helpers/client-builders.js";

afterEach(() => {
  runCleanups();
  act(() => {
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    useManagerThreadsStore.setState({ threads: new Map() });
  });
});

const thread = (id: string, title: string) =>
  managerThreadDto(id, { title, createdAt: "2026-10-19T00:00:00.000Z", lastActivityAt: "2026-10-19T00:00:00.000Z" });

async function render(scope: AgentChatScope, messages: AgentMessageDto[] = []) {
  useManagerThreadsStore.setState({ threads: new Map([thread("t_here", "Eviction order"), thread("t_parser", "Parser errors")].map((t) => [t.id, t])) });
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const calls = mockFetch((call) => call.method === "POST"
    ? jsonResponse({ threadId: scope.type === "worker" ? "t_worker" : scope.threadId, messageId: "m1", wakeId: null, queued: false }, 202)
    : jsonResponse({ thread: { id: scope.type === "worker" ? "t_worker" : scope.threadId }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null }));
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={scope} /></MemoryRouter>);
  await settle();
  const textarea = host.querySelector("textarea")!;
  const type = (text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")!.set!.call(textarea, text);
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
  const enter = () => act(async () => {
    textarea.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const titles = () => [...document.querySelectorAll('[data-slot="mention-list"] [data-slot="mention-title"]')].map((el) => el.textContent);
  const posts = () => calls.filter((call) => call.method === "POST").map((call) => JSON.parse(String(call.init!.body)) as Record<string, unknown>);
  return { type, enter, titles, posts };
}

test("a manager thread's composer offers the other threads, and its message names the one picked", async () => {
  const c = await render({ type: "manager", threadId: "t_here" });
  await c.type("@");
  expect(c.titles()).toEqual(["Parser errors"]);
  await c.type("Follow up on @Parser");
  await c.enter();
  await c.enter();
  await settle();
  expect(c.posts().at(-1)).toMatchObject({ content: "Follow up on @Parser errors", mentions: [{ kind: "thread", id: "t_parser", label: "Parser errors" }] });
  // On its way, the message already draws the mention as a tag.
  expect([...document.querySelectorAll('[data-slot="mention-tag"]')].map((a) => a.getAttribute("href"))).toEqual(["/threads/t_parser"]);
});

test("a stored message's mentions are drawn as tags in the conversation", async () => {
  const stored = agentMessage({
    id: "u1", threadId: "t_here", seq: 1,
    content: { type: "text", text: "Continue from @Parser errors", metadata: mentionsMetadata([{ kind: "thread", id: "t_parser", label: "Parser errors" }]) }
  });
  await render({ type: "manager", threadId: "t_here" }, [stored]);
  expect([...document.querySelectorAll('[data-slot="mention-tag"]')].map((a) => [a.getAttribute("href"), a.textContent])).toEqual([["/threads/t_parser", "@Parser errors"]]);
});

test("Your agent's composer offers every open thread", async () => {
  const c = await render({ type: "global", threadId: "t_global" });
  await c.type("@");
  expect(c.titles().sort()).toEqual(["Eviction order", "Parser errors"]);
});

test("a worker's composer has no @ list", async () => {
  const c = await render({ type: "worker", featureId: "feat_1" });
  await c.type("@Parser");
  expect(c.titles()).toEqual([]);
});
