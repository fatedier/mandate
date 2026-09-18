export interface CanvasFit {
  /** 1 when the content fits; < 1 when the frame is scaled down to the container. */
  scale: number;
  /** The iframe's layout width: the container when it fits, the content width when scaled. */
  frameWidth: number;
  /** The wrapper's height after scaling, so the card reserves the right space. */
  wrapperHeight: number;
}

/** The bridge reports `Math.ceil(scrollWidth)` while the container can be
 *  fractional (358.5px), so a document that exactly fills its frame can read
 *  one pixel wider than the container. That is a fit, not a 99.7% scale. */
const FIT_SLACK_PX = 1;

/** A canvas authored for a wide viewport is shown whole, scaled to the
 *  container, rather than clipped or scrolled: the card is a preview. Widths
 *  that are unknown (0 / NaN) mean "trust the container" — the bridge only
 *  reports a width once it has measured. */
export function computeCanvasFit(input: { contentWidth: number; contentHeight: number; containerWidth: number }): CanvasFit {
  const { contentWidth, contentHeight, containerWidth } = input;
  const height = Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : 0;
  if (!Number.isFinite(contentWidth) || contentWidth <= 0 || !Number.isFinite(containerWidth) || containerWidth <= 0 || contentWidth <= containerWidth + FIT_SLACK_PX) {
    return { scale: 1, frameWidth: containerWidth > 0 ? containerWidth : contentWidth, wrapperHeight: height };
  }
  const scale = containerWidth / contentWidth;
  return { scale, frameWidth: contentWidth, wrapperHeight: Math.ceil(height * scale) };
}
