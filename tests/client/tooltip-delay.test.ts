import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { TOOLTIP_DELAY_MS, TOOLTIP_SKIP_DELAY_MS } from "@/lib/tooltip-delay";
import { sourceFiles } from "../helpers/source-files.js";

const root = join(import.meta.dir, "..", "..");

test("tooltips wait for the pointer to rest, then let neighbours open quickly", () => {
  // Instant tooltips fired a label per icon when brushing past the collapsed
  // rail. 600ms is in the range native macOS and
  // the usual desktop apps use; the skip delay keeps a scan quick.
  expect(TOOLTIP_DELAY_MS).toBeGreaterThanOrEqual(500);
  expect(TOOLTIP_SKIP_DELAY_MS).toBeGreaterThan(0);
  expect(TOOLTIP_SKIP_DELAY_MS).toBeLessThan(TOOLTIP_DELAY_MS);
});

test("no provider in the app overrides the delay with a shorter one", () => {
  const shorter: string[] = [];
  for (const file of sourceFiles(join(root, "src", "client"), /\.tsx$/, 200)) {
    // The wrapper passes the delay it is given on.
    if (file === join(root, "src", "client", "components", "ui", "tooltip.tsx")) continue;
    for (const [, ms] of readFileSync(file, "utf8").matchAll(/delayDuration=\{\s*(\d+)\s*\}/g)) {
      if (Number(ms) < TOOLTIP_DELAY_MS) shorter.push(`${relative(root, file)}: ${ms}`);
    }
  }
  expect(shorter).toStrictEqual([]);
});
