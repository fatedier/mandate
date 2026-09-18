import { expect, test } from "bun:test";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "@/lib/tooltip-delay";

const root = join(import.meta.dir, "..", "..");

test("tooltips wait for the pointer to rest, then let neighbours open quickly", () => {
  // Instant tooltips fired a label per icon when brushing past the collapsed
  // rail (user report, 2026-09-18). 600ms is in the range native macOS and
  // the usual desktop apps use; the skip delay keeps a scan quick.
  expect(TOOLTIP_DELAY_MS).toBeGreaterThanOrEqual(500);
  expect(TOOLTIP_SKIP_DELAY_MS).toBeGreaterThan(0);
  expect(TOOLTIP_SKIP_DELAY_MS).toBeLessThan(TOOLTIP_DELAY_MS);
});

test("no provider in the app overrides the delay with a shorter one", () => {
  const hits = execSync(`grep -rn "delayDuration={" src/client --include='*.tsx' || true`, { cwd: root, encoding: "utf8" })
    .split("\n").filter((l) => l && !l.includes("components/ui/tooltip.tsx"));
  for (const hit of hits) {
    const ms = Number(hit.match(/delayDuration=\{(\d+)\}/)?.[1] ?? Number.NaN);
    expect(Number.isNaN(ms) || ms >= TOOLTIP_DELAY_MS).toBe(true);
  }
});
