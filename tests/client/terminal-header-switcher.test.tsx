import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TerminalHeader } from "@/routes/terminal/TerminalHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

function render(switcher?: { windowName: string; paneIndex: number | null; open: boolean; onToggle: () => void }, isMobile = true) {
  // A test may render twice (mobile then desktop); drop the previous mount so
  // afterEach is not left holding only the last one.
  act(() => root?.unmount()); host?.remove();
  host = document.createElement("div"); document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<TerminalHeader isMobile={isMobile} titleText="Untracked file forensics" path="~/local/frp" statusOk status="connected" statusDotClass="bg-green"
      windowZoomed={false} fitWidth={false} fitBrowserUser={false} keysVisible={false}
      onToggleFitWidth={() => {}} onToggleBrowserFit={() => {}} onToggleKeysVisible={() => {}} onRefresh={() => {}} switcher={switcher} />);
  });
  return host!;
}

test("mobile with a switcher: the title is a button naming window / [n] pane, expanded state mirrors the sheet", () => {
  let toggled = 0;
  const el = render({ windowName: "main", paneIndex: 1, open: false, onToggle: () => { toggled += 1; } });
  const btn = el.querySelector<HTMLButtonElement>('[aria-label="Switch window or pane"]')!;
  expect(btn === null).toBe(false);
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(btn.textContent).toContain("main");
  expect(btn.textContent).toContain("[1]");
  expect(btn.textContent).toContain("Untracked file forensics");
  expect(btn.className.split(/\s+/)).toContain("h-9");
  act(() => { btn.click(); });
  expect(toggled).toBe(1);
  expect(el.textContent).not.toContain("~/local/frp");
  expect(el.querySelector('[aria-label="Terminal actions"]') === null).toBe(false);
  // The status dot survives the switch to the button (§8.1 "then the status dot").
  expect(el.querySelector('[aria-label="connected"]') === null).toBe(false);
});

test("mobile without a switcher, and desktop, keep today's header", () => {
  const el = render(undefined, true);
  expect(el.querySelector('[aria-label="Switch window or pane"]') === null).toBe(true);
  expect(el.textContent).toContain("~/local/frp");
  const desk = render({ windowName: "main", paneIndex: 1, open: false, onToggle: () => {} }, false);
  expect(desk.querySelector('[aria-label="Switch window or pane"]') === null).toBe(true);
  // Desktop is byte-identical to before: the dot sits INSIDE the title div, beside the h2.
  expect(desk.querySelector("h2")!.parentElement!.querySelector('[aria-label="connected"]') === null).toBe(false);
});
