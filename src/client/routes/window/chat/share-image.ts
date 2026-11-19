import { createContext } from "react";

/** Draws a card as a PNG. Behind a context so tests give their own. */
export type ShareImageRenderer = (node: HTMLElement) => Promise<Blob>;

/** The most pixels a canvas holds in iOS Safari, the smallest of the
 *  browsers', and the tallest side any draws. Past them a canvas comes back
 *  empty rather than failing. */
const CANVAS_MAX_AREA = 16_777_216;
const CANVAS_MAX_SIDE = 32_767;

/** The scale a card is drawn at: twice its size, or for a tall one the
 *  largest that still fits a canvas (blurrier, but whole). */
export function shareImageScale(width: number, height: number): number {
  const byArea = Math.sqrt(CANVAS_MAX_AREA / Math.max(1, width * height));
  const bySide = CANVAS_MAX_SIDE / Math.max(1, width, height);
  // Just under: the canvas is sized from the scale with rounding.
  return Math.min(2, byArea * 0.999, bySide * 0.999);
}

/** The card as modern-screenshot draws it, on its own background. Buttons
 *  inside (a code block's Copy, shown on a touch screen) are left out. The
 *  library loads on the first image. */
export const renderShareImage: ShareImageRenderer = async (node) => {
  const { domToBlob } = await import("modern-screenshot");
  const box = node.getBoundingClientRect();
  return domToBlob(node, {
    scale: shareImageScale(box.width, box.height),
    type: "image/png",
    backgroundColor: getComputedStyle(node).backgroundColor,
    filter: (el) => !(el instanceof HTMLButtonElement)
  });
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Whether a drawn image is one: a canvas the browser would not draw comes
 *  back as a few bytes that are not a PNG, without an error. */
export async function isPng(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, PNG_SIGNATURE.length).arrayBuffer());
  return head.length === PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => head[i] === byte);
}

export const ShareImageRendererContext = createContext<ShareImageRenderer>(renderShareImage);
