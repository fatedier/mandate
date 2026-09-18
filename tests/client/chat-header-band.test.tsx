import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AgentChatPanel } from "@/routes/window/chat/AgentChatPanel";
import { useAgentChatStore, newThreadState } from "@/store/agent-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAgentChatStore.getState();
let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realGetComputedStyle = globalThis.getComputedStyle;

beforeEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = (async () => new Response(JSON.stringify({
    thread: null, messages: [], hasMore: false, contextUsage: null
  }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  useAgentChatStore.setState({
    drawerOpen: true, drawerMode: "side", drawerScope: { type: "manager" },
    threadsByScope: new Map([["manager", { ...newThreadState(), threadId: "t1" }]])
  });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  globalThis.getComputedStyle = realGetComputedStyle;
  useAgentChatStore.setState(initial, true);
});

async function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  // Await the mount-time thread load so its updateThread lands before
  // afterEach resets the shared store.
  await act(async () => {
    root = createRoot(host!);
    root.render(<MemoryRouter initialEntries={["/projects"]}><AgentChatPanel /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 0));
  });
  return host!;
}

test("the chat header is a 52px drag band with 28px icon buttons", async () => {
  await render();
  const header = host!.querySelector('[data-slot="chat-header"]')!;
  expect(header === null).toBe(false);
  expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(header.className.split(/\s+/)).toContain("h-13");
  for (const label of ["Maximize chat", "New manager chat", "Collapse chat dock"]) {
    const button = header.querySelector(`[aria-label="${label}"]`)!;
    expect([label, button === null]).toEqual([label, false]);
    expect([label, button.getAttribute("data-size")]).toEqual([label, "icon-xs"]);
  }
});
