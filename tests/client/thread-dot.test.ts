import { expect, test } from "bun:test";
import { isThreadNew, sortThreadsForSidebar } from "../../src/client/lib/thread-dot.js";

test("isThreadNew: an unseen visible row", () => {
  expect(isThreadNew({ lastVisibleSeq: 5, seenSeq: 4 })).toBe(true);
  expect(isThreadNew({ lastVisibleSeq: 5, seenSeq: 5 })).toBe(false);
  expect(isThreadNew({ lastVisibleSeq: 0, seenSeq: 0 })).toBe(false);
});

test("sortThreadsForSidebar: needs you first, then a decision or a result, then newest activity", () => {
  const threads = [
    { id: "a", lastActivityAt: "2026-09-27T10:00:00Z" },
    { id: "b", lastActivityAt: "2026-09-27T12:00:00Z" },
    { id: "c", lastActivityAt: "2026-09-27T09:00:00Z" },
    { id: "d", lastActivityAt: "2026-09-27T08:00:00Z" }
  ];
  const dots = { a: "idle", b: "idle", c: "decision", d: "needs_you" } as const;
  expect(sortThreadsForSidebar(threads, (id) => dots[id as keyof typeof dots]).map((t) => t.id)).toEqual(["d", "c", "b", "a"]);
  // A failure ranks with what needs you: first, by activity.
  const failed = { a: "failed", b: "idle", c: "result", d: "needs_you" } as const;
  expect(sortThreadsForSidebar(threads, (id) => failed[id as keyof typeof failed]).map((t) => t.id)).toEqual(["a", "d", "c", "b"]);
  // Watching ranks with working and idle: by activity.
  const mixed = { a: "watching", b: "idle", c: "working", d: "result" } as const;
  expect(sortThreadsForSidebar(threads, (id) => mixed[id as keyof typeof mixed]).map((t) => t.id)).toEqual(["d", "b", "a", "c"]);
});
