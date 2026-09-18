import { expect, test } from "bun:test";
import { computeCanvasFit } from "@/routes/canvas/canvas-fit";

test("content narrower than the container is not scaled", () => {
  expect(computeCanvasFit({ contentWidth: 320, contentHeight: 400, containerWidth: 358 }))
    .toEqual({ scale: 1, frameWidth: 358, wrapperHeight: 400 });
});

test("content wider than the container is scaled down to fit, height follows", () => {
  // 30 * 358 / 1024 = 10.49: ceil gives 11 where round would give 10, so the
  // card reserves whole pixels rather than clipping the last row.
  const fit = computeCanvasFit({ contentWidth: 1024, contentHeight: 30, containerWidth: 358 });
  expect(fit.frameWidth).toBe(1024);
  expect(fit.scale).toBeCloseTo(358 / 1024, 4);
  expect(fit.wrapperHeight).toBe(11);
});

test("one pixel over the container still fits: scrollWidth is ceil'd while the container can be fractional", () => {
  expect(computeCanvasFit({ contentWidth: 358, contentHeight: 300, containerWidth: 358 }).scale).toBe(1);
  expect(computeCanvasFit({ contentWidth: 359, contentHeight: 300, containerWidth: 358 }).scale).toBe(1);
  expect(computeCanvasFit({ contentWidth: 360, contentHeight: 300, containerWidth: 358 }).scale).toBeLessThan(1);
});

test("an unknown or zero width means no scaling", () => {
  expect(computeCanvasFit({ contentWidth: 0, contentHeight: 300, containerWidth: 358 }).scale).toBe(1);
  expect(computeCanvasFit({ contentWidth: Number.NaN, contentHeight: 300, containerWidth: 358 }).scale).toBe(1);
  expect(computeCanvasFit({ contentWidth: 900, contentHeight: 300, containerWidth: 0 }).scale).toBe(1);
});
