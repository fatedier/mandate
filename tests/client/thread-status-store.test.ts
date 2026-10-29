import { afterEach, expect, test } from "bun:test";
import { useThreadStatusStore } from "../../src/client/store/thread-status.js";
import type { WaitingEntryDto } from "../../src/shared/api/thread-status.js";

afterEach(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [] }));

const failed: WaitingEntryDto = {
  key: "thread:t2:failed", kind: "thread", waiting: "failed", threadId: "t2", threadTitle: "Cache work",
  featureId: null, workerName: null, text: "boom", place: null
};

test("a snapshot replaces the states and the list whole", () => {
  useThreadStatusStore.getState().replace({ threads: [{ threadId: "t1", state: "working" }, { threadId: "t2", state: "failed" }], waiting: [failed] });
  expect([...useThreadStatusStore.getState().states]).toEqual([["t1", "working"], ["t2", "failed"]]);
  expect(useThreadStatusStore.getState().waiting).toEqual([failed]);
  // A thread the next snapshot leaves out is gone, not kept from before.
  useThreadStatusStore.getState().replace({ threads: [{ threadId: "t1", state: "idle" }], waiting: [] });
  expect([...useThreadStatusStore.getState().states]).toEqual([["t1", "idle"]]);
  expect(useThreadStatusStore.getState().waiting).toEqual([]);
});
