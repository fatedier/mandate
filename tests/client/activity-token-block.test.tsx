import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TokenBlock } from "@/routes/activity/CallDetailPanel";
import { tokenBreakdown } from "@/routes/activity/format";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the block says, not how it is laid out — happy-dom performs no layout.
 * The readings that must reach the screen are the two parts, because those are
 * the ones the single-cell version truncated away on 95% of calls.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(groups: ReturnType<typeof tokenBreakdown>): string {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TokenBlock groups={groups} />);
  });
  return host.textContent ?? "";
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

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

test("spells the count out rather than rounding it", () => {
  // The list column shows 25.4k so it fits a fixed width. This panel has room,
  // and a reader who opened one call is asking what that call did.
  const text = render(tokenBreakdown(CALL));
  expect(text).not.toContain("25.4k");
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
