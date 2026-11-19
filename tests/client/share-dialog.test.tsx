import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { ChatConversation } from "@/routes/window/chat/ChatConversation";
import { ShareImageRendererContext, type ShareImageRenderer } from "@/routes/window/chat/share-image";
import { useAgentChatStore } from "@/store/agent-chat";
import { useManagerThreadsStore } from "@/store/manager-threads";
import type { AgentMessageDto, ManagerThreadDto } from "@shared/api/agents";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { agentMessage, stub } from "../helpers/typed.js";

afterEach(() => {
  runCleanups();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
  useManagerThreadsStore.setState({ threads: new Map() });
});

// Share opens on what was picked: the image of it, or its Markdown, with a
// way to save it and, where the browser allows, to copy it. Done, picking
// ends; closed, picking goes on.

const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 10, 0, s)).toISOString();
const T = "t_d1";
const MESSAGES: AgentMessageDto[] = [
  agentMessage({ id: "u1", threadId: T, seq: 1, createdAt: at(1), content: { type: "text", text: "Can the gallery make thumbnails for large photos?" } }),
  agentMessage({ id: "a1", threadId: T, seq: 2, role: "assistant", source: "self", wakeId: "w1", createdAt: at(2), content: { type: "assistant", text: "Partly, and at a cost." } }),
  agentMessage({ id: "u2", threadId: T, seq: 3, createdAt: at(3), content: { type: "text", text: "Raise the limit to 4096 px first?" } }),
  agentMessage({ id: "b1", threadId: T, seq: 4, role: "assistant", source: "self", wakeId: "w2", createdAt: at(4), content: { type: "assistant", text: "Yes, a **safe** first step." } })
];
const PNG = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])], { type: "image/png" });

/** The conversation, its renderer a stub that keeps what it was given. */
async function render(renderer: ShareImageRenderer, post: (call: FetchCall) => Response = () => jsonResponse({ path: "/Users/someone/Downloads/x.png" })) {
  useManagerThreadsStore.setState({ threads: new Map([[T, stub<ManagerThreadDto>({ id: T, title: "Image limit", running: false, failed: false, stopReason: null, questions: [], archivedAt: null })]]) });
  const calls = mockFetch((call) => (call.method === "POST" ? post(call) : jsonResponse({ thread: { id: T }, messages: MESSAGES, hasMore: false, contextUsage: null, activeWake: null, readAt: null })));
  const { host, rerender } = await mountAsync(
    <ShareImageRendererContext.Provider value={renderer}>
      <MemoryRouter><ChatConversation scope={{ type: "manager", threadId: T }} /></MemoryRouter>
    </ShareImageRendererContext.Provider>
  );
  await settle();
  return { host, rerender, posts: () => calls.filter((call) => call.method === "POST") };
}
const click = (el: Element) => act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
const button = (root: ParentNode, name: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name);
const dialog = () => document.querySelector<HTMLElement>('[data-slot="share-dialog"]');

/** Picks the last exchange from its reply and opens Share. */
async function openShare(host: HTMLElement) {
  const shares = [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Share as image"]')];
  await click(shares[shares.length - 1]!);
  await click(host.querySelector('[data-slot="share-open"]')!);
  await settle();
}

function captureDownloads() {
  const downloads: { name: string; href: string }[] = [];
  const spy = spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.href });
  });
  onCleanup(() => spy.mockRestore());
  return downloads;
}
function secureContext(on: boolean) {
  const was = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(window, "isSecureContext", { value: on, configurable: true });
  onCleanup(() => { if (was) Object.defineProperty(window, "isSecureContext", was); else delete (window as { isSecureContext?: boolean }).isSecureContext; });
}
function spyToasts() {
  const success = spyOn(toast, "success").mockImplementation(() => "");
  const error = spyOn(toast, "error").mockImplementation(() => "");
  onCleanup(() => { success.mockRestore(); error.mockRestore(); });
  return { success, error };
}

test("the image is of the picked messages only; off a secure page it can be saved, not copied, and saving ends picking", async () => {
  secureContext(false);
  const drawn: string[] = [];
  const { host } = await render(async (node) => { drawn.push(node.textContent ?? ""); return PNG; });
  const toasts = spyToasts();
  const downloads = captureDownloads();
  await openShare(host);
  expect(dialog()?.textContent).toContain("Share");
  expect(drawn).toEqual(["Raise the limit to 4096 px first?Yes, a safe first step."]);
  expect(dialog()!.querySelector("img")?.getAttribute("src")).toStartWith("blob:");
  expect(button(dialog()!, "Copy image")).toBeUndefined();
  await click(button(dialog()!, "Save image")!);
  await settle();
  expect(downloads.map((d) => d.name)).toHaveLength(1);
  expect(downloads[0]!.name).toMatch(/^mandate-share-\d{8}-\d{6}\.png$/);
  expect(toasts.success).toHaveBeenCalledWith("Image saved");
  expect(dialog() === null).toBe(true);
  expect(host.querySelector('[data-slot="share-bar"]') === null).toBe(true);
});

test("on a secure page the image is copied; in the desktop app it is saved through the server", async () => {
  secureContext(true);
  const written: unknown[] = [];
  const clipboard = { write: async (items: unknown[]) => { written.push(...items); } };
  const nav = window.navigator as unknown as { clipboard?: unknown };
  const wasClipboard = nav.clipboard;
  Object.defineProperty(window.navigator, "clipboard", { value: clipboard, configurable: true });
  const g = globalThis as { ClipboardItem?: unknown };
  const wasItem = g.ClipboardItem;
  g.ClipboardItem = class { constructor(readonly parts: Record<string, Blob>) {} };
  onCleanup(() => { Object.defineProperty(window.navigator, "clipboard", { value: wasClipboard, configurable: true }); g.ClipboardItem = wasItem; });
  const { host, posts } = await render(async () => PNG);
  const toasts = spyToasts();
  await openShare(host);
  await click(button(dialog()!, "Copy image")!);
  await settle();
  expect(written).toHaveLength(1);
  expect((written[0] as { parts: Record<string, Blob> }).parts["image/png"]).toBe(PNG);
  expect(toasts.success).toHaveBeenCalledWith("Image copied");
  expect(host.querySelector('[data-slot="share-bar"]') === null).toBe(true);

  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  onCleanup(() => { delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
  await openShare(host);
  await click(button(dialog()!, "Save image")!);
  await settle();
  expect(posts().map((call) => [new URL(call.url, "http://x").pathname, (call.init?.headers as Record<string, string>)["Content-Type"]])).toEqual([["/api/share-files", "image/png"]]);
  expect(toasts.success).toHaveBeenCalledWith("Image saved");
});

test("Markdown holds the picked messages as text; it is copied, or saved as a .md file", async () => {
  secureContext(false);
  const { host } = await render(async () => PNG);
  const toasts = spyToasts();
  const downloads = captureDownloads();
  await openShare(host);
  await click(button(dialog()!, "Markdown")!);
  expect(dialog()!.querySelector('[data-slot="share-markdown"]')?.textContent).toBe("**You:** Raise the limit to 4096 px first?\n\nYes, a **safe** first step.\n");
  await click(button(dialog()!, "Save file")!);
  await settle();
  expect(downloads[0]?.name).toMatch(/^mandate-share-\d{8}-\d{6}\.md$/);
  expect(toasts.success).toHaveBeenCalledWith("File saved");
  // Copy text works off a secure page too (the browser's copy command).
  await openShare(host);
  await click(button(dialog()!, "Markdown")!);
  expect(button(dialog()!, "Copy text") !== undefined).toBe(true);
});

test("what is not a PNG (a canvas too large comes back empty) is no image: it says so, and nothing can be saved", async () => {
  secureContext(false);
  const { host } = await render(async () => new Blob([new Uint8Array(54)], { type: "image/png" }));
  await openShare(host);
  expect(dialog()!.textContent).toContain("Couldn't create the image. Try again.");
  expect(dialog()!.querySelector("img") === null).toBe(true);
  expect(button(dialog()!, "Save image")?.disabled).toBe(true);
});

test("Share open in one conversation does not come back with it after another was shown", async () => {
  secureContext(false);
  const { host, rerender } = await render(async () => PNG);
  await openShare(host);
  expect(dialog() !== null).toBe(true);
  const other = "t_d2";
  useManagerThreadsStore.setState({ threads: new Map([...useManagerThreadsStore.getState().threads, [other, stub<ManagerThreadDto>({ id: other, title: "Other", running: false, failed: false, stopReason: null, questions: [], archivedAt: null })]]) });
  const view = (id: string) => (
    <ShareImageRendererContext.Provider value={async () => PNG}>
      <MemoryRouter><ChatConversation scope={{ type: "manager", threadId: id }} /></MemoryRouter>
    </ShareImageRendererContext.Provider>
  );
  await rerender(view(other));
  await settle();
  expect(dialog() === null).toBe(true);
  await rerender(view(T));
  await settle();
  expect(dialog() === null).toBe(true);
  expect(host.querySelector('[data-slot="share-bar"]') === null).toBe(true);
});

test("an image that could not be made says so and is tried again; closing Share goes back to picking", async () => {
  secureContext(false);
  let tries = 0;
  const { host } = await render(async () => { tries++; if (tries === 1) throw new Error("canvas tainted"); return PNG; });
  await openShare(host);
  expect(dialog()!.textContent).toContain("Couldn't create the image. Try again.");
  expect(button(dialog()!, "Save image")?.disabled).toBe(true);
  await click(button(dialog()!, "Retry")!);
  await settle();
  expect(tries).toBe(2);
  expect(dialog()!.querySelector("img") !== null).toBe(true);
  // Closed: the picks stand.
  await act(async () => { document.activeElement?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await settle();
  expect(dialog() === null).toBe(true);
  expect(host.querySelector('[data-slot="share-bar"]')?.textContent).toContain("2 selected");
});
