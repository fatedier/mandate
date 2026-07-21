import { expect, test } from "bun:test";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

const TEST_THROTTLE_MS = 1;

function makeItem(id: string, lastActivityAt: string): WorkItemDto {
  return {
    id, featureId: "f", projectId: "p", title: "t",
    summary: null, canvasId: null, needsUser: null,
    phase: "design", phaseDetail: null,
    summaryUpdatedAt: null, summaryUpdatedBy: null,
    lastActivityAt, createdAt: lastActivityAt, updatedAt: lastActivityAt
  };
}

function makeEmitter() {
  return new AgentSseEmitter({ workItemUpdateThrottleMs: TEST_THROTTLE_MS });
}

function waitForThrottleWindow() {
  return new Promise((r) => setTimeout(r, TEST_THROTTLE_MS + 5));
}

test("workItemUpdated: first emit fires immediately, burst coalesces into one trailing emit", async () => {
  const emitter = makeEmitter();
  const received: WorkItemDto[] = [];
  emitter.addSink((e) => {
    if (e.event === "workItemUpdated") received.push(e.data.item);
  });

  for (let i = 0; i < 5; i++) {
    emitter.emit("workItemUpdated", { item: makeItem("wi-1", String(i)) });
  }
  // immediate emit is the first one (lastActivityAt='0')
  expect(received.length).toBe(1);
  expect(received[0].lastActivityAt).toBe("0");

  // wait past throttle window
  await waitForThrottleWindow();
  // trailing emit should now have arrived with the latest data ('4')
  expect(received.length).toBe(2);
  expect(received[1].lastActivityAt).toBe("4");
});

test("workItemUpdated: throttle is per-item", async () => {
  const emitter = makeEmitter();
  const received: WorkItemDto[] = [];
  emitter.addSink((e) => {
    if (e.event === "workItemUpdated") received.push(e.data.item);
  });
  emitter.emit("workItemUpdated", { item: makeItem("wi-1", "a") });
  emitter.emit("workItemUpdated", { item: makeItem("wi-2", "b") });
  expect(received.length).toBe(2);
  expect(received[0].id).toBe("wi-1");
  expect(received[1].id).toBe("wi-2");
  await waitForThrottleWindow();
  // No trailing emits expected (no coalesced updates).
  expect(received.length).toBe(2);
});

test("workItemUpdated: single emit does not produce trailing duplicate", async () => {
  const emitter = makeEmitter();
  const received: WorkItemDto[] = [];
  emitter.addSink((e) => {
    if (e.event === "workItemUpdated") received.push(e.data.item);
  });
  emitter.emit("workItemUpdated", { item: makeItem("wi-1", "a") });
  await waitForThrottleWindow();
  expect(received.length).toBe(1);
});

test("other event kinds pass through unchanged", async () => {
  const emitter = makeEmitter();
  const received: any[] = [];
  emitter.addSink((e) => received.push(e));
  // some other event — pick one that exists. workItemCreated is a safe bet.
  emitter.emit("workItemCreated", { item: makeItem("wi-1", "a") });
  emitter.emit("workItemCreated", { item: makeItem("wi-1", "b") });
  expect(received.length).toBe(2);
});

test("workItemUpdated: trailing emit after window with another burst restarts", async () => {
  const emitter = makeEmitter();
  const received: WorkItemDto[] = [];
  emitter.addSink((e) => {
    if (e.event === "workItemUpdated") received.push(e.data.item);
  });
  emitter.emit("workItemUpdated", { item: makeItem("wi-1", "a") });
  emitter.emit("workItemUpdated", { item: makeItem("wi-1", "b") });
  await waitForThrottleWindow();
  expect(received.length).toBe(2);
  // After window, a new emit fires immediately again.
  emitter.emit("workItemUpdated", { item: makeItem("wi-1", "c") });
  expect(received.length).toBe(3);
});
