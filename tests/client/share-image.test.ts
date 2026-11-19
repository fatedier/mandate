import { expect, test } from "bun:test";
import { shareImageScale } from "@/routes/window/chat/share-image";

// The image is drawn at twice the card's size, unless a canvas that large is
// more than a browser draws: iOS Safari's holds 16,777,216 pixels, and none
// is taller than 32,767. Past those the canvas comes back empty, so a tall
// card is drawn at a smaller scale, all of it.

const AREA = 16_777_216;
const SIDE = 32_767;
const fits = (width: number, height: number, scale: number) =>
  width * scale * height * scale <= AREA && height * scale <= SIDE && width * scale <= SIDE;

test("a card is drawn at twice its size while that fits a canvas, and at what fits beyond", () => {
  expect(shareImageScale(480, 1200)).toBe(2);
  expect(shareImageScale(480, 8000)).toBe(2);
  for (const height of [12_000, 30_000, 200_000]) {
    const scale = shareImageScale(480, height);
    expect(scale).toBeLessThan(2);
    expect(fits(480, height, scale)).toBe(true);
    // As large as fits, near enough: a tenth more would not.
    expect(fits(480, height, scale * 1.1)).toBe(false);
  }
});
