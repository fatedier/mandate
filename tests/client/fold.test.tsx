import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { Fold } from "@/components/Fold";
import { runCleanups } from "../helpers/cleanup.js";
import { fireAnimation as fire, foldsCloseAnimated } from "../helpers/motion.js";
import { mount } from "../helpers/mount.js";

/** A fold's content grows in and out (Radix Collapsible, the fold keyframes
 *  on its measured height) instead of popping. */

afterEach(runCleanups);

const content = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="fold"]');
/** Shut: the fold is hidden and holds nothing (Radix keeps its empty box). */
const shut = (host: HTMLElement) => { const el = content(host); return el === null || (el.hidden && el.childElementCount === 0); };

const settle = () => act(async () => { await Promise.resolve(); });
/** A few animation frames. */
const frames = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

test("a fold holds its content only while open, and moves as it opens and closes", () => {
  const view = (open: boolean) => <div><Fold open={open}><p>The release notes are drafted.</p></Fold></div>;
  const { host, rerender } = mount(view(false));
  // Shut: nothing of its content in the page.
  expect(shut(host)).toBe(true);
  rerender(view(true));
  const opened = content(host)!;
  expect(opened.textContent).toBe("The release notes are drafted.");
  expect(opened.getAttribute("data-state")).toBe("open");
  // It moves as it opens and closes, and clips only while it moves (no
  // overflow class: an open fold shows a focus ring at its edge).
  const classes = opened.className.split(/\s+/);
  expect(["data-[state=open]:animate-fold-open", "data-[state=closed]:animate-fold-close", "overflow-hidden"].map((c) => classes.includes(c))).toEqual([true, true, false]);
  // It adds no element around a content given no class of its own.
  expect(opened.firstElementChild!.tagName).toBe("P");
  expect(opened.parentElement!.parentElement === host).toBe(true);
  rerender(view(false));
  // happy-dom runs no CSS animation, so the close ends at once.
  expect(shut(host)).toBe(true);
});

test("its owner's class and padding go on an inner box, so the fold itself can shrink to nothing", () => {
  const { host } = mount(<Fold open className="rounded-sm border py-2" id="earlier-steps"><p>Earlier work</p></Fold>);
  const el = content(host)!;
  expect(el.id).toBe("earlier-steps");
  expect(el.className.split(/\s+/).some((c) => c === "py-2" || c === "border")).toBe(false);
  const inner = el.firstElementChild as HTMLElement;
  expect(inner.className).toBe("rounded-sm border py-2");
  expect(inner.textContent).toBe("Earlier work");
});

test("while it opens, the height it grows to follows content that arrives meanwhile", async () => {
  const view = (open: boolean) => <Fold open={open}><p>Loading…</p></Fold>;
  const { host, rerender } = mount(view(false));
  rerender(view(true));
  const el = content(host)!;
  const target = () => el.style.getPropertyValue("--fold-height");
  let full = 40;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => full });
  fire(el, "animationstart", "fold-open");
  expect(target()).toBe("40px");
  // The earlier steps arrive while it grows: it grows to them.
  full = 320;
  await frames();
  expect(target()).toBe("320px");
  // A nested fold's animation is not its own.
  fire(el.querySelector("p")!, "animationend", "fold-open");
  expect(target()).toBe("320px");
  // Once it has opened, it stops following and leaves its height to the page.
  fire(el, "animationend", "fold-open");
  full = 999;
  await frames();
  expect(target()).toBe("");
});

test("an open cancelled on its way (less motion asked for meanwhile) stops following its content", async () => {
  const view = (open: boolean) => <Fold open={open}><p>Loading…</p></Fold>;
  const { host, rerender } = mount(view(false));
  rerender(view(true));
  const el = content(host)!;
  let full = 40;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => full });
  fire(el, "animationstart", "fold-open");
  fire(el, "animationcancel", "fold-open");
  full = 320;
  await frames();
  expect(el.style.getPropertyValue("--fold-height")).toBe("");
});

test("it says when it has shut: at once with nothing to animate, else when its close animation ends", async () => {
  const closed: string[] = [];
  const view = (open: boolean) => <Fold open={open} onClosed={() => closed.push("shut")}><p>steps</p></Fold>;
  // React's development check mounts it twice: that is no close.
  const { rerender } = mount(<StrictMode>{view(true)}</StrictMode>);
  await settle();
  expect(closed).toStrictEqual([]);
  rerender(<StrictMode>{view(false)}</StrictMode>);
  await settle();
  expect(closed).toStrictEqual(["shut"]);
});

test("while its close animation runs, its content stays and it has not yet shut", async () => {
  const closed: string[] = [];
  foldsCloseAnimated();
  const view = (open: boolean) => <Fold open={open} onClosed={() => closed.push("shut")}><p>steps</p></Fold>;
  const { host, rerender } = mount(view(true));
  rerender(view(false));
  await settle();
  expect([closed.length, content(host)!.textContent]).toEqual([0, "steps"]);
  fire(content(host)!, "animationend", "fold-close");
  await settle();
  expect([closed, shut(host)]).toEqual([["shut"], true]);
});
