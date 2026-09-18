import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { DesktopChatPanel } from "@/routes/window/chat/DesktopChatPanel";
import { useAgentChatStore, newThreadState } from "@/store/agent-chat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initial = useAgentChatStore.getState();
const realFetch = globalThis.fetch;
const realGetComputedStyle = globalThis.getComputedStyle;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  // AgentChatPanel loads its thread at mount; answer with an empty one. The
  // composer measures line-height, which happy-dom does not compute.
  (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({
    thread: null, messages: [], hasMore: false, contextUsage: null
  }), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  useAgentChatStore.setState({
    drawerOpen: true,
    drawerMode: "side",
    drawerScope: { type: "manager" },
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
    root.render(
      <MemoryRouter initialEntries={["/projects"]}>
        <DesktopChatPanel width={600} workspaceWidth={1200} workerZoomed={false} />
      </MemoryRouter>
    );
    await new Promise((r) => setTimeout(r, 0));
  });
  return host!;
}

test("the split divider shows a grip inside the resize separator", async () => {
  const el = await render();
  const separator = el.querySelector('[aria-label="Resize chat panel"]')!;
  const grip = separator.querySelector('[data-slot="pane-grip"]');
  expect(grip === null).toBe(false);
  // Hover-only: hidden at rest, revealed by the handle's hover/active state.
  const tokens = grip!.className.split(/\s+/);
  expect(tokens).toContain("opacity-0");
  expect(tokens).toContain("group-hover:opacity-100");
});

test("the maximized chat has no separator and a 55rem column", async () => {
  act(() => useAgentChatStore.setState({ drawerMode: "fullscreen" }));
  const el = await render();
  expect(el.querySelector('[aria-label="Resize chat panel"]') === null).toBe(true);
  expect(el.querySelector(".max-w-\\[55rem\\]") === null).toBe(false);
});
