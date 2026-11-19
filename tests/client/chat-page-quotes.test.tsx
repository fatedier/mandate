import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { usePageQuotes } from "@/store/page-quotes";
import type { AgentMessageDto } from "@shared/api/agents";
import { pageQuotesMetadata } from "@shared/page-quotes";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle, typeInto } from "../helpers/mount.js";
import { agentMessage } from "../helpers/typed.js";

afterEach(() => {
  runCleanups();
  act(() => {
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    usePageQuotes.setState({ byKey: new Map() });
  });
});

const SCOPE: AgentChatScope = { type: "personal", threadId: "thr_g" };
const KEY = "personal:thr_g";
const ORDER = { path: "index.html", text: "Order #12 waits for your approval" };
const DRY_BED = { path: "beds.html", text: "bed 3 dried out at 14:00" };

async function render(messages: AgentMessageDto[] = [], { queued = false } = {}) {
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const calls = mockFetch((call) => call.method === "POST"
    ? jsonResponse({ threadId: "thr_g", messageId: queued ? null : "m1", wakeId: null, queued }, 202)
    : jsonResponse({ thread: { id: "thr_g" }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null }));
  const { host } = await mountAsync(<MemoryRouter><ChatConversation scope={SCOPE} /></MemoryRouter>);
  await settle();
  const textarea = host.querySelector("textarea")!;
  const chips = () => [...host.querySelectorAll('[data-slot="composer-quote"]')];
  const sendButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
  const posts = () => calls.filter((call) => call.method === "POST").map((call) => JSON.parse(String(call.init!.body)) as Record<string, unknown>);
  return { host, textarea, chips, sendButton, posts };
}

test("quotes in the composer show above it, each from the page with a way to take it out", async () => {
  usePageQuotes.setState({ byKey: new Map([[KEY, [ORDER, DRY_BED]]]) });
  const c = await render();
  expect(c.chips().map((chip) => chip.textContent)).toEqual([`From the page${ORDER.text}`, `From the page${DRY_BED.text}`]);
  const remove = c.chips()[0]!.querySelector<HTMLButtonElement>('button[aria-label="Remove quote"]')!;
  expect(remove.getAttribute("title")).toBe("Remove quote");
  await act(async () => { remove.click(); });
  expect(c.chips().map((chip) => chip.textContent)).toEqual([`From the page${DRY_BED.text}`]);
  expect(usePageQuotes.getState().byKey.get(KEY)).toEqual([DRY_BED]);
});

test("a quote picked while the composer shows is added there and takes the focus", async () => {
  const c = await render();
  expect(c.chips()).toHaveLength(0);
  await act(async () => { usePageQuotes.getState().add(KEY, ORDER); });
  expect(c.chips()).toHaveLength(1);
  expect(document.activeElement === c.textarea).toBe(true);
});

test("a message may be quotes alone; they go with it, the composer lets go of them, and its bubble shows them", async () => {
  usePageQuotes.setState({ byKey: new Map([[KEY, [ORDER]]]) });
  const c = await render();
  expect(c.sendButton().disabled).toBe(false);
  await act(async () => { c.sendButton().click(); });
  await settle();
  expect(c.posts().at(-1)).toMatchObject({ content: "", pageQuotes: [ORDER] });
  expect(c.chips()).toHaveLength(0);
  expect(usePageQuotes.getState().byKey.has(KEY)).toBe(false);
  expect([...c.host.querySelectorAll('[data-slot="page-quote"]')].map((q) => q.textContent)).toEqual([ORDER.text]);
});

test("words and quotes go together; without either there is nothing to send", async () => {
  const c = await render();
  expect(c.sendButton().disabled).toBe(true);
  await act(async () => { usePageQuotes.getState().add(KEY, ORDER); });
  await typeInto(c.textarea, "Can this wait until Monday?", "Can this wait until Monday?".length);
  await act(async () => { c.sendButton().click(); });
  await settle();
  expect(c.posts().at(-1)).toMatchObject({ content: "Can this wait until Monday?", pageQuotes: [ORDER] });
});

test("a stored message's quotes are drawn in grey above its words", async () => {
  await render([agentMessage({
    id: "m_q", threadId: "thr_g", seq: 1, role: "user", source: "user",
    content: { type: "text", text: "Is this still blocked?", metadata: pageQuotesMetadata([DRY_BED]) },
    createdAt: "2026-11-15T09:00:00.000Z"
  })]);
  const quote = document.querySelector('[data-slot="page-quote"]')!;
  expect(quote.textContent).toBe(DRY_BED.text);
  expect(quote.getAttribute("title")).toBe(DRY_BED.text);
  expect(quote.nextElementSibling?.textContent ?? "").toContain("Is this still blocked?");
});

test("quotes alone waiting behind a running turn are listed by what they quote", async () => {
  usePageQuotes.setState({ byKey: new Map([[KEY, [ORDER]]]) });
  const c = await render([], { queued: true });
  await act(async () => { c.sendButton().click(); });
  await settle();
  expect(c.host.querySelector('[data-slot="queued-message"]')?.textContent).toBe(ORDER.text);
});
