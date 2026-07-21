import { expect, test } from "bun:test";
import { computePillSnap } from "../src/client/lib/voice-pill-snap.js";

const baseInput = {
  pillHeight: 48,
  viewportWidth: 393,
  viewportHeight: 852,
  safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  margin: 16
};

test("computePillSnap: pointer on left half snaps to left", () => {
  const r = computePillSnap({ ...baseInput, pointerX: 100, pointerY: 400 });
  expect(r.side).toBe("left");
});

test("computePillSnap: pointer on right half snaps to right", () => {
  const r = computePillSnap({ ...baseInput, pointerX: 350, pointerY: 400 });
  expect(r.side).toBe("right");
});

test("computePillSnap: pointer just past midpoint snaps right", () => {
  const r = computePillSnap({ ...baseInput, pointerX: 197, pointerY: 400 });
  expect(r.side).toBe("right");
});

test("computePillSnap: topPx centers pill around pointer y", () => {
  // pointerY 400, pillHeight 48 → topPx 400 - 24 = 376
  const r = computePillSnap({ ...baseInput, pointerX: 100, pointerY: 400 });
  expect(r.topPx).toBe(376);
});

test("computePillSnap: topPx clamps to viewport top + margin", () => {
  // pointerY 0 would give topPx = -24, clamp to margin (16)
  const r = computePillSnap({ ...baseInput, pointerX: 100, pointerY: 0 });
  expect(r.topPx).toBe(16);
});

test("computePillSnap: topPx clamps to viewport bottom - pillHeight - margin", () => {
  // pointerY 852 (bottom) gives topPx = 852 - 24 = 828; clamp to
  // 852 - 48 - 16 = 788
  const r = computePillSnap({ ...baseInput, pointerX: 100, pointerY: 852 });
  expect(r.topPx).toBe(788);
});

test("computePillSnap: top safe-area inset adds to top clamp", () => {
  const r = computePillSnap({
    ...baseInput,
    safeAreaInsets: { top: 44, right: 0, bottom: 0, left: 0 },
    pointerX: 100,
    pointerY: 0
  });
  expect(r.topPx).toBe(44 + 16);
});

test("computePillSnap: bottom safe-area inset adds to bottom clamp", () => {
  const r = computePillSnap({
    ...baseInput,
    safeAreaInsets: { top: 0, right: 0, bottom: 34, left: 0 },
    pointerX: 100,
    pointerY: 852
  });
  expect(r.topPx).toBe(852 - 48 - 34 - 16);
});

test("computePillSnap: pill larger than viewport pins to top safe-area", () => {
  const r = computePillSnap({
    ...baseInput,
    pillHeight: 1000,
    safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 },
    pointerX: 100,
    pointerY: 400
  });
  // viewport 852, pill 1000, safe-area 44+34, margin 16 → rawMaxTop is negative.
  // Should pin to minTop = 44 + 16 = 60.
  expect(r.topPx).toBe(60);
});
