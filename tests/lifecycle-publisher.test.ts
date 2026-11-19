import { expect, test } from "bun:test";
import { publishTo, type LifecycleEvent } from "../src/server/runtime/events.js";
import type { ProjectDto } from "../src/shared/api-contracts.js";

test("a published lifecycle event reaches its receiver", () => {
  const received: LifecycleEvent[] = [];
  const publish = publishTo((event) => { received.push(event); });

  publish({ type: "projectCreated", data: { id: "p1" } as ProjectDto });

  expect(received).toStrictEqual([{ type: "projectCreated", data: { id: "p1" } as ProjectDto }]);
});

test("a receiver that fails is logged, and the code that published goes on", () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    const publish = publishTo(() => { throw new Error("boom"); });
    expect(() => publish({ type: "paneCreated", data: { paneId: "%1" } })).not.toThrow();
    expect(errors.length).toBe(1);
  } finally {
    console.error = originalError;
  }
});
