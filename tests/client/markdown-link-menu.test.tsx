import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MarkdownView } from "@/components/MarkdownView";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, settle } from "../helpers/mount.js";

// The desktop app's own menu for a link (Open Link / Copy Link). It opens at
// the document's top level, outside the text it came from: inside a
// transcript, whose edges are masked to fade, a menu drawn in
// place was faded and clipped. It is a Radix context menu, so inside a modal
// dialog, which turns the page's pointer events off, it keeps its own.

afterEach(() => runCleanups());

const TEXT = "See [the docs](https://example.com/docs).";

function desktop() {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  onCleanup(() => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });
  // Radix places a context menu at the pointer with a DOMRect, which the
  // harness does not register: happy-dom's own, while the test runs.
  const before = Object.getOwnPropertyDescriptor(globalThis, "DOMRect");
  Object.defineProperty(globalThis, "DOMRect", { configurable: true, writable: true, value: (window as unknown as { DOMRect: typeof DOMRect }).DOMRect });
  onCleanup(() => {
    if (before) Object.defineProperty(globalThis, "DOMRect", before);
    else delete (globalThis as { DOMRect?: unknown }).DOMRect;
  });
}

function clipboard(): string[] {
  const copied: string[] = [];
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const saved = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  onCleanup(() => {
    if (secure) Object.defineProperty(window, "isSecureContext", secure); else delete (window as { isSecureContext?: boolean }).isSecureContext;
    if (saved) Object.defineProperty(navigator, "clipboard", saved); else delete (navigator as { clipboard?: unknown }).clipboard;
  });
  return copied;
}

async function rightClick(link: Element) {
  const event = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  act(() => { link.dispatchEvent(event); });
  await settle();
  return event;
}

const item = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((n) => n.textContent === label)!;

test("in the desktop app a link's menu opens outside the text it came from, and Copy Link copies the address", async () => {
  desktop();
  const copied = clipboard();
  const { host } = mount(<div className="fade-y-edges"><MarkdownView text={TEXT} /></div>);
  await rightClick(host.querySelector("a")!);
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect([...menu.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent)).toEqual(["Open Link", "Copy Link"]);
  expect(host.contains(menu)).toBe(false);
  await act(async () => { item("Copy Link").click(); });
  await settle();
  expect(copied).toStrictEqual(["https://example.com/docs"]);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
});

test("inside a modal dialog the menu takes its own pointer events, where the dialog turned the page's off", async () => {
  desktop();
  mount(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Reply</DialogTitle>
        <DialogDescription>The worker's reply</DialogDescription>
        <MarkdownView text={TEXT} />
      </DialogContent>
    </Dialog>
  );
  await settle();
  expect(document.body.style.pointerEvents).toBe("none");
  await rightClick(document.querySelector('[role="dialog"] a')!);
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
  expect(menu.style.pointerEvents).toBe("auto");
  expect(item("Open Link") === undefined).toBe(false);
});

test("in a browser a link keeps the browser's own menu", async () => {
  const { host } = mount(<MarkdownView text={TEXT} />);
  const event = await rightClick(host.querySelector("a")!);
  expect(event.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]') === null).toBe(true);
});

// Where the async clipboard is unavailable (an insecure context), the copy
// falls back to a focused, selected textarea and execCommand("copy"). The
// menu must not pull focus back from that textarea before the copy runs, as
// a modal menu's focus trap does.
test("Copy Link's fallback copy keeps its textarea focused while it copies", async () => {
  desktop();
  const secure = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  const exec = Object.getOwnPropertyDescriptor(document, "execCommand");
  const copied: string[] = [];
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string) => {
      const active = document.activeElement;
      if (command === "copy" && active instanceof window.HTMLTextAreaElement) copied.push(active.value);
      return true;
    }
  });
  onCleanup(() => {
    if (secure) Object.defineProperty(window, "isSecureContext", secure); else delete (window as { isSecureContext?: boolean }).isSecureContext;
    if (exec) Object.defineProperty(document, "execCommand", exec); else delete (document as { execCommand?: unknown }).execCommand;
  });
  const { host } = mount(<MarkdownView text={TEXT} />);
  await rightClick(host.querySelector("a")!);
  await act(async () => { item("Copy Link").click(); });
  await settle();
  expect(copied).toStrictEqual(["https://example.com/docs"]);
});
