import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActivityListSkeleton, ActivitySkeleton } from "@/routes/activity/ActivitySkeleton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null; let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });

test("the skeleton is shaped as header lines + panels in --sel, never a card", () => {
  host = document.createElement("div"); document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<ActivitySkeleton />); });
  expect(host!.innerHTML.includes("bg-card")).toBe(false);
  expect(host!.querySelectorAll('[data-slot="section-panel"]').length).toBeGreaterThan(0);
  const blocks = Array.from(host!.querySelectorAll('[data-slot="skeleton"]'));
  expect(blocks.length).toBeGreaterThan(0);
  for (const b of blocks) expect(b.className.split(/\s+/)).toContain("bg-sel");
});

test("the list skeleton is one header line over six 40px rows, each holding a --sel bar", () => {
  host = document.createElement("div"); document.body.appendChild(host);
  act(() => { root = createRoot(host!); root.render(<ActivityListSkeleton />); });
  expect(host!.querySelectorAll('[data-slot="section-header"]').length).toBe(1);
  const rows = Array.from(host!.querySelectorAll('[data-slot="section-panel"] [data-slot="section-row"]'));
  expect(rows.length).toBe(6);
  for (const r of rows) {
    expect(r.className.split(/\s+/)).toContain("min-h-10");
    const bar = r.querySelector('[data-slot="skeleton"]')!;
    expect(bar === null).toBe(false);
    expect(bar.className.split(/\s+/)).toContain("bg-sel");
  }
  expect(host!.innerHTML.includes("bg-card")).toBe(false);
});
