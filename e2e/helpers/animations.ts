import type { Page } from "playwright";

export interface StartedAnimation {
  /** Each keyframe's width, else its transform. */
  frames: Array<string | null>;
  duration: number | null;
}

/** Notes, from the page's first script on, every animation an element starts
 *  (Element.prototype.animate), keyed by the element's data-slot, and still
 *  starts it. */
export async function recordAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const started: Record<string, Array<{ frames: Array<string | null>; duration: number | null }>> = {};
    (window as unknown as { __animations: typeof started }).__animations = started;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      const slot = this.getAttribute("data-slot") ?? "";
      const frames = Array.isArray(keyframes) ? keyframes.map((k) => (k.width ?? k.transform ?? null) as string | null) : [];
      const duration = typeof options === "number" ? options : typeof options?.duration === "number" ? options.duration : null;
      (started[slot] ??= []).push({ frames, duration });
      return animate.call(this, keyframes, options);
    };
  });
}

/** Forgets what was recorded so far: a test's own changes start from none. */
export function forgetAnimations(page: Page): Promise<void> {
  return page.evaluate(() => {
    const started = (window as unknown as { __animations: Record<string, unknown[]> }).__animations;
    for (const slot of Object.keys(started)) delete started[slot];
  });
}

/** Waits until nothing moves on the element of this data-slot (or it is gone). */
export function motionEnded(page: Page, slot: string): Promise<unknown> {
  return page.waitForFunction((s) => {
    const el = document.querySelector(`[data-slot="${s}"]`);
    return !el || el.getAnimations().length === 0;
  }, slot);
}

export function startedAnimations(page: Page, slot: string): Promise<StartedAnimation[]> {
  return page.evaluate((s) => (window as unknown as { __animations: Record<string, StartedAnimation[]> }).__animations[s] ?? [], slot);
}

/** Notes, from the page's first script on, every CSS animation that starts
 *  (animationstart), as [data-slot of the element, animation name]. */
export async function recordCssAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const started: Array<[string, string]> = [];
    (window as unknown as { __cssAnimations: typeof started }).__cssAnimations = started;
    document.addEventListener("animationstart", (event) => {
      const target = event.target as Element;
      started.push([target.getAttribute("data-slot") ?? target.tagName.toLowerCase(), (event as AnimationEvent).animationName]);
    }, true);
  });
}

/** The CSS animations that started on elements of this data-slot, by name. */
export function cssAnimations(page: Page, slot: string): Promise<string[]> {
  return page.evaluate((s) => (window as unknown as { __cssAnimations: Array<[string, string]> }).__cssAnimations.filter(([at]) => at === s).map(([, name]) => name), slot);
}

