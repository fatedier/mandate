import { expect, test } from "bun:test";
import { formatTokenCount } from "../src/shared/format-tokens.js";
import { formatTokenCount as fromActivity } from "../src/client/routes/activity/activity-model.js";

// One formatter for every token figure the app prints: the Activity page, the
// header's meter, a compaction's boundary, and the server's /context line.
test("formatTokenCount: one decimal from a thousand up, and the client's is the same function", () => {
  expect([999, 1000, 8473, 250_000, 250_395, 1_500_000, 6_530_300_000].map(formatTokenCount))
    .toEqual(["999", "1.0k", "8.5k", "250.0k", "250.4k", "1.5M", "6.5B"]);
  expect([formatTokenCount(null), formatTokenCount(Number.NaN)]).toEqual(["—", "—"]);
  expect(fromActivity).toBe(formatTokenCount);
});

test("formatTokenCount switches unit at a thousand, a million and a billion, not before", () => {
  // The thousands branch runs all the way to the million, so the last figure
  // before the switch is four digits of thousands, not a rounded "1.0M".
  // A 30-day window can carry billions of input tokens. Without the billion
  // tier 6.5B reads as "6530.3M", which is a number nobody parses.
  expect([12_345, 999_999, 1_000_000, 2_500_000, 999_999_999, 1_000_000_000].map(formatTokenCount))
    .toEqual(["12.3k", "1000.0k", "1.0M", "2.5M", "1000.0M", "1.0B"]);
});
