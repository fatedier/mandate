import { afterEach, expect, test } from "bun:test";
import { useRef } from "react";
import { useSlideOnReorder } from "@/hooks/useSlideOnReorder";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { recordAnimations, reducedMotion } from "../helpers/motion.js";
import { mount } from "../helpers/mount.js";

// The sidebar's threads slide to their new place when their order changes:
// played from where each was to where it is, only when the list changes.

afterEach(runCleanups);

function List({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useSlideOnReorder(ref);
  return <div ref={ref} className="relative">{ids.map((id) => <a key={id} data-slide-key={id}>{id}</a>)}</div>;
}
/** happy-dom lays nothing out: each row is 30px under the one before. */
function rowsStacked() {
  const proto = window.HTMLElement.prototype;
  const own = Object.getOwnPropertyDescriptor(proto, "offsetTop");
  Object.defineProperty(proto, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) { return this.dataset.slideKey ? Array.prototype.indexOf.call(this.parentElement!.children, this) * 30 : 0; }
  });
  onCleanup(() => { if (own) Object.defineProperty(proto, "offsetTop", own); else delete (proto as unknown as { offsetTop?: unknown }).offsetTop; });
}
const slides = (started: ReturnType<typeof recordAnimations>) => started.map((a) => [a.text, a.keyframes[0]!.transform, a.duration]);

test("rows that change their place slide from where they were; what the list opened with does not move", () => {
  rowsStacked();
  const started = recordAnimations();
  const { rerender } = mount(<List ids={["Release notes", "Cache metrics", "Docs pass"]} />);
  expect(started).toStrictEqual([]);
  rerender(<List ids={["Docs pass", "Release notes", "Cache metrics"]} />);
  expect(slides(started)).toEqual([
    ["Docs pass", "translateY(60px)", 240],
    ["Release notes", "translateY(-30px)", 240],
    ["Cache metrics", "translateY(-30px)", 240]
  ]);
});

test("a row that comes is just there; those it pushes down slide", () => {
  rowsStacked();
  const started = recordAnimations();
  const { rerender } = mount(<List ids={["Release notes", "Cache metrics"]} />);
  rerender(<List ids={["Search timeout", "Release notes", "Cache metrics"]} />);
  expect(slides(started)).toEqual([["Release notes", "translateY(-30px)", 240], ["Cache metrics", "translateY(-30px)", 240]]);
  // Drawn again with nothing moved: nothing slides.
  rerender(<List ids={["Search timeout", "Release notes", "Cache metrics"]} />);
  expect(started.length).toBe(2);
});

test("asked for less motion, rows are just in their new place", () => {
  rowsStacked();
  reducedMotion();
  const started = recordAnimations();
  const { rerender } = mount(<List ids={["Release notes", "Cache metrics"]} />);
  rerender(<List ids={["Cache metrics", "Release notes"]} />);
  expect(started).toStrictEqual([]);
});
