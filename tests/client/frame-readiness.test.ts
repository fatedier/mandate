import { expect, test } from "bun:test";
import { reduceFrameReadiness } from "@/routes/canvas/frame-readiness";

test("the first height makes a loading frame ready", () => {
  expect(reduceFrameReadiness("loading", { type: "height" })).toBe("ready");
});

test("a timeout fails a loading frame but never a ready one", () => {
  expect(reduceFrameReadiness("loading", { type: "timeout" })).toBe("failed");
  expect(reduceFrameReadiness("ready", { type: "timeout" })).toBe("ready");
});

test("a late height after a failure still recovers", () => {
  expect(reduceFrameReadiness("failed", { type: "height" })).toBe("ready");
});

test("reset returns to loading from any phase (new document or a retry remount)", () => {
  expect(reduceFrameReadiness("ready", { type: "reset" })).toBe("loading");
  expect(reduceFrameReadiness("failed", { type: "reset" })).toBe("loading");
  expect(reduceFrameReadiness("loading", { type: "reset" })).toBe("loading");
});
