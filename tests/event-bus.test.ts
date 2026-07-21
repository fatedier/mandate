import { expect, test } from "bun:test";
import { AppEventBus, type LifecycleEvent } from "../src/server/runtime/events.js";

test("AppEventBus delivers events to matching subscribers", () => {
  const bus = new AppEventBus();
  const received: LifecycleEvent[] = [];

  bus.on("lifecycle", ({ event }) => {
    received.push(event);
  });

  bus.emit({ type: "lifecycle", event: { type: "projectCreated", data: { id: "p1" } } });

  expect(received).toEqual([{ type: "projectCreated", data: { id: "p1" } }]);
});

test("AppEventBus unsubscribe removes handler", () => {
  const bus = new AppEventBus();
  let count = 0;

  const unsubscribe = bus.on("lifecycle", () => {
    count += 1;
  });
  unsubscribe();

  bus.emit({ type: "lifecycle", event: { type: "featureCreated", data: { id: "f1" } } });

  expect(count).toBe(0);
});

test("AppEventBus isolates handler failures", () => {
  const bus = new AppEventBus();
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    let delivered = false;
    bus.on("lifecycle", () => {
      throw new Error("boom");
    });
    bus.on("lifecycle", () => {
      delivered = true;
    });

    bus.emit({ type: "lifecycle", event: { type: "paneCreated", data: { paneId: "%1" } } });

    expect(delivered).toBe(true);
    expect(errors.length).toBe(1);
  } finally {
    console.error = originalError;
  }
});
