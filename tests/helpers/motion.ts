import { act } from "react";
import { onCleanup } from "./cleanup.js";

/** The person asked their system for less motion: matchMedia says so for
 *  prefers-reduced-motion, and answers every other query as before. */
export function reducedMotion(): void {
  const own = Object.getOwnPropertyDescriptor(window, "matchMedia");
  const original = window.matchMedia.bind(window);
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => (query.includes("prefers-reduced-motion")
      ? { matches: query.includes("reduce"), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false } as MediaQueryList
      : original(query))
  });
  onCleanup(() => {
    if (own) Object.defineProperty(window, "matchMedia", own);
    else delete (window as unknown as { matchMedia?: unknown }).matchMedia;
  });
}

export interface StartedAnimation {
  /** The element's data-slot. */
  slot: string | null;
  keyframes: Keyframe[];
  duration: number | undefined;
  /** The element's text as it started. */
  text: string | null;
}

/** Notes every animation an element starts (Element.prototype.animate), and
 *  still starts it. */
export function recordAnimations(): StartedAnimation[] {
  const started: StartedAnimation[] = [];
  const proto = window.Element.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, "animate");
  const animate = proto.animate;
  Object.defineProperty(proto, "animate", {
    configurable: true, writable: true,
    value: function (this: Element, keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
      started.push({ slot: this.getAttribute("data-slot"), keyframes, duration: typeof options?.duration === "number" ? options.duration : undefined, text: this.textContent });
      return animate.call(this, keyframes, options);
    }
  });
  onCleanup(() => {
    if (own) Object.defineProperty(proto, "animate", own);
    else delete (proto as unknown as { animate?: unknown }).animate;
  });
  return started;
}

/** Waits, in real time, until `predicate` holds: for what lands when an
 *  animation ends. */
export async function untilMotionEnds(predicate: () => boolean, label: string, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
  if (!predicate()) throw new Error(`untilMotionEnds gave up: ${label}`);
}

/** happy-dom runs no CSS animation, so a fold opens and shuts at once in a
 *  unit test. These play one as the browser would report it. */

/** An animation event as the browser fires it on `el`. */
export function fireAnimation(el: Element, type: "animationstart" | "animationend" | "animationcancel", animationName: string) {
  const event = new window.Event(type, { bubbles: true });
  Object.defineProperty(event, "animationName", { value: animationName });
  act(() => { el.dispatchEvent(event); });
}

/** The computed animation name of elements of this data-slot, as `name`
 *  gives it for each (on the page's global and on window: Radix calls the
 *  bare global, and reads it once an element mounts, so call this before
 *  mounting). Radix matches an ended animation with CSS.escape, which
 *  happy-dom lacks: the names here need no escaping. Undone after the test. */
export function slotAnimating(slot: string, name: (el: Element) => string) {
  const scope = globalThis as { CSS?: unknown };
  if (scope.CSS === undefined) {
    scope.CSS = { escape: (value: string) => value };
    onCleanup(() => { delete scope.CSS; });
  }
  const original = window.getComputedStyle.bind(window);
  const stub = (el: Element, pseudo?: string | null) => {
    const style = original(el, pseudo);
    if (!(el instanceof window.HTMLElement) || el.getAttribute("data-slot") !== slot) return style;
    return new Proxy(style, { get: (target, key) => (key === "animationName" ? name(el) : Reflect.get(target, key)) });
  };
  for (const owner of new Set<object>([window, globalThis])) {
    const own = Object.getOwnPropertyDescriptor(owner, "getComputedStyle");
    Object.defineProperty(owner, "getComputedStyle", { configurable: true, writable: true, value: stub });
    onCleanup(() => {
      if (own) Object.defineProperty(owner, "getComputedStyle", own);
      else delete (owner as { getComputedStyle?: unknown }).getComputedStyle;
    });
  }
}

/** Folds that run their close animation (fold-close) and none on opening. */
export const foldsCloseAnimated = () => slotAnimating("fold", (el) => (el.getAttribute("data-state") === "closed" ? "fold-close" : "none"));
