import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { CopyButton } from "@/components/CopyButton";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";
import { fakeClock } from "../helpers/fake-clock.js";
import { jest } from "bun:test";

// Copied, the button's mark turns to a check for 1.5 s: the check comes in
// with a small fade, and so does the copy mark coming back; at rest, as the
// page opens, nothing moves.

afterEach(runCleanups);

test("the check fades in once copied, and the copy mark fades back after; at rest nothing moves", async () => {
  // The page is no secure context here: the copy goes by the document's copy command.
  const own = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => true });
  onCleanup(() => { if (own) Object.defineProperty(document, "execCommand", own); else delete (document as unknown as { execCommand?: unknown }).execCommand; });
  const { host } = mount(<CopyButton text="bun test cache-expiry" label="Copy command" />);
  const mark = () => host.querySelector("svg")!.getAttribute("class")!.split(/\s+/);
  const button = host.querySelector("button")!;
  expect([button.getAttribute("aria-label"), mark().includes("animate-in")]).toEqual(["Copy command", false]);
  fakeClock();
  await act(async () => { button.click(); for (let i = 0; i < 10; i++) await Promise.resolve(); });
  expect([button.getAttribute("aria-label"), mark().includes("animate-in")]).toEqual(["Copied", true]);
  act(() => { jest.advanceTimersByTime(1500); });
  expect([button.getAttribute("aria-label"), mark().includes("animate-in")]).toEqual(["Copy command", true]);
});
