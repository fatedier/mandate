import { expect, test } from "bun:test";
import { act } from "react";
import { TerminalHeader } from "@/routes/terminal/TerminalHeader";
import { mount } from "../helpers/mount.js";

function render(switcher?: { windowName: string; paneIndex: number | null; open: boolean; onToggle: () => void }, isMobile = true) {
  return mount(<TerminalHeader isMobile={isMobile} titleText="Build cache notes" path="~/works/project-1" status="connected"
    windowZoomed={false} fitWidth={false} fitBrowserUser={false} keysVisible={false}
    onToggleFitWidth={() => {}} onToggleBrowserFit={() => {}} onToggleKeysVisible={() => {}} onRefresh={() => {}} switcher={switcher} />).host;
}

test("mobile with a switcher: the title is a button naming window / [n] pane, expanded state mirrors the sheet", () => {
  let toggled = 0;
  const el = render({ windowName: "main", paneIndex: 1, open: false, onToggle: () => { toggled += 1; } });
  const btn = el.querySelector<HTMLButtonElement>('[aria-label="Switch window or pane"]')!;
  expect(btn === null).toBe(false);
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  expect(btn.textContent).toContain("main");
  expect(btn.textContent).toContain("[1]");
  expect(btn.textContent).toContain("Build cache notes");
  expect(btn.className.split(/\s+/)).toContain("h-9");
  act(() => { btn.click(); });
  expect(toggled).toBe(1);
  expect(el.textContent).not.toContain("~/works/project-1");
  expect(el.querySelector('[aria-label="Terminal actions"]') === null).toBe(false);
  // The status dot survives the switch to the button.
  expect(el.querySelector('[aria-label="connected"]') === null).toBe(false);
});

test("mobile without a switcher, and desktop, keep today's header", () => {
  const el = render(undefined, true);
  expect(el.querySelector('[aria-label="Switch window or pane"]') === null).toBe(true);
  expect(el.textContent).toContain("~/works/project-1");
  const desk = render({ windowName: "main", paneIndex: 1, open: false, onToggle: () => {} }, false);
  expect(desk.querySelector('[aria-label="Switch window or pane"]') === null).toBe(true);
  // Desktop is byte-identical to before: the dot sits INSIDE the title div, beside the h2.
  expect(desk.querySelector("h2")!.parentElement!.querySelector('[aria-label="connected"]') === null).toBe(false);
});
