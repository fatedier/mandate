import { expect, test } from "bun:test";
import { ActivityListSkeleton, ActivitySkeleton } from "@/routes/activity/ActivitySkeleton";
import { mount } from "../helpers/mount.js";

test("the skeleton is shaped as header lines + panels in --sel, never a card", () => {
  const { host } = mount(<ActivitySkeleton />);
  expect(host.innerHTML.includes("bg-card")).toBe(false);
  expect(host.querySelectorAll('[data-slot="section-panel"]').length).toBeGreaterThan(0);
  const blocks = Array.from(host.querySelectorAll('[data-slot="skeleton"]'));
  expect(blocks.length).toBeGreaterThan(0);
  for (const b of blocks) expect(b.className.split(/\s+/)).toContain("bg-sel");
});

test("the list skeleton is one header line over six 40px rows, each holding a --sel bar", () => {
  const { host } = mount(<ActivityListSkeleton />);
  expect(host.querySelectorAll('[data-slot="section-header"]').length).toBe(1);
  const rows = Array.from(host.querySelectorAll('[data-slot="section-panel"] [data-slot="section-row"]'));
  expect(rows.length).toBe(6);
  for (const r of rows) {
    expect(r.className.split(/\s+/)).toContain("min-h-10");
    const bar = r.querySelector('[data-slot="skeleton"]')!;
    expect(bar === null).toBe(false);
    expect(bar.className.split(/\s+/)).toContain("bg-sel");
  }
  expect(host.innerHTML.includes("bg-card")).toBe(false);
});
