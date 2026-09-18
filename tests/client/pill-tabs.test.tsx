import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PillTabs } from "@/components/PillTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

const ITEMS = [{ id: "overview", label: "Overview" }, { id: "logs", label: "Logs" }] as const;

test("pill tabs: tablist semantics, selected pill carries bg-sel, ids and aria-controls when idPrefix is set", () => {
  host = document.createElement("div"); document.body.appendChild(host);
  let picked = "";
  act(() => { root = createRoot(host!); root.render(<PillTabs items={ITEMS} value="overview" onChange={(id) => { picked = id; }} aria-label="Activity views" idPrefix="activity" />); });
  const list = host!.querySelector('[role="tablist"]')!;
  expect(list === null).toBe(false);
  expect(list.getAttribute("data-slot")).toBe("page-tabs");
  expect(list.getAttribute("aria-label")).toBe("Activity views");
  for (const t of ["flex", "gap-0.5"]) expect(list.className.split(/\s+/)).toContain(t);
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  for (const t of tabs) expect(t.getAttribute("type")).toBe("button");
  expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  expect(tabs[0]!.id).toBe("activity-tab-overview");
  expect(tabs[0]!.getAttribute("aria-controls")).toBe("activity-panel-overview");
  expect(tabs[1]!.getAttribute("aria-controls")).toBe(null);
  for (const t of ["inline-flex", "h-7", "items-center", "rounded-sm", "px-2.5", "text-xs", "font-medium"]) expect(tabs[0]!.className.split(/\s+/)).toContain(t);
  expect(tabs[0]!.className.split(/\s+/)).toContain("bg-sel");
  expect(tabs[0]!.className.split(/\s+/)).toContain("text-foreground");
  expect(tabs[1]!.className.split(/\s+/)).toContain("text-chrome");
  expect(tabs[1]!.className.split(/\s+/)).not.toContain("bg-sel");
  expect(host!.innerHTML.includes("rounded-md")).toBe(false);
  expect(host!.innerHTML.includes("border-b-2")).toBe(false);
  act(() => { (tabs[1] as HTMLButtonElement).click(); });
  expect(picked).toBe("logs");
});

test("role=nav renders a <nav> with aria-current instead of tablist semantics", () => {
  host = document.createElement("div"); document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<PillTabs items={ITEMS} value="logs" onChange={() => {}} aria-label="Memory views" role="nav" />); });
  const nav = host!.querySelector("nav")!;
  expect(nav === null).toBe(false);
  expect(nav.getAttribute("aria-label")).toBe("Memory views");
  expect(nav.getAttribute("data-slot")).toBe("page-tabs");
  for (const t of ["flex", "gap-0.5"]) expect(nav.className.split(/\s+/)).toContain(t);
  expect(nav.querySelector('[role="tab"]') === null).toBe(true);
  const buttons = Array.from(nav.querySelectorAll("button"));
  for (const b of buttons) expect(b.getAttribute("type")).toBe("button");
  expect(buttons.map((b) => b.getAttribute("aria-current"))).toEqual([null, "page"]);
  expect(buttons[1]!.className.split(/\s+/)).toContain("bg-sel");
  expect(buttons[0]!.className.split(/\s+/)).toContain("text-chrome");
});
