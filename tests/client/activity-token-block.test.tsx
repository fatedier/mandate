import { expect, test } from "bun:test";
import { TokenBlock } from "@/routes/activity/CallDetailPanel";
import { tokenBreakdown } from "@/routes/activity/format";
import { mount } from "../helpers/mount.js";

/**
 * What the block says, not how it is laid out — happy-dom performs no layout.
 * The readings that must reach the screen are the two parts, because those are
 * the ones the single-cell version truncated away on most calls.
 */

function render(groups: ReturnType<typeof tokenBreakdown>): string {
  return mount(<TokenBlock groups={groups} />).host.textContent ?? "";
}

const CALL = {
  inputTokens: 25_412,
  outputTokens: 200,
  reasoningTokens: 139,
  cacheReadTokens: 22_016
};

test("shows both wholes and both parts, with each part's share", () => {
  const text = render(tokenBreakdown(CALL));
  expect(text).toContain("25,412");
  expect(text).toContain("22,016");
  expect(text).toContain("86.6%");
  expect(text).toContain("200");
  expect(text).toContain("139");
  expect(text).toContain("69.5%");
});

test("names the readings, so a number is never on screen unlabelled", () => {
  const text = render(tokenBreakdown(CALL)).toLowerCase();
  for (const label of ["tokens", "input", "cached", "output", "reasoning"]) {
    expect(text).toContain(label);
  }
});

test("omits a part the provider never reported", () => {
  const text = render(tokenBreakdown({ ...CALL, cacheReadTokens: 0, reasoningTokens: 0 }));
  expect(text).toContain("25,412");
  expect(text.toLowerCase()).not.toContain("cached");
  expect(text.toLowerCase()).not.toContain("reasoning");
});

test("says so when the call recorded no counts at all", () => {
  // Rather than rendering an empty labelled box, which reads as a bug.
  const text = render(tokenBreakdown({
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null
  }));
  expect(text).toContain("—");
});
