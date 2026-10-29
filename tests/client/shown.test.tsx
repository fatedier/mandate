import { afterEach, expect, test } from "bun:test";
import { act, StrictMode } from "react";
import { Shown } from "@/components/Shown";
import { runCleanups } from "../helpers/cleanup.js";
import { fireAnimation, slotAnimating } from "../helpers/motion.js";
import { mount } from "../helpers/mount.js";

/** What comes and goes with a move each way (the question over the composer,
 *  the chat's working line): in as it comes, out as it goes, kept as it was
 *  while it goes. */

afterEach(runCleanups);

const ENTER = "animate-in fade-in-0";
const EXIT = "animate-out fade-out-0";
const settle = () => act(async () => { await Promise.resolve(); });
const box = (host: ParentNode) => host.querySelector<HTMLElement>('[data-slot="shown"]');
const entering = (host: ParentNode) => box(host)!.className.split(/\s+/).includes("animate-in");

test("what was there as the page opened does not move in; what comes later does, and what mounts told to appear", () => {
  const view = (when: boolean, word: string) => <Shown when={when} enter={ENTER} exit={EXIT}><p>{word}</p></Shown>;
  const { host, rerender } = mount(view(true, "Tag 3.21 today?"));
  expect(entering(host)).toBe(false);
  rerender(view(false, ""));
  rerender(view(true, "Wait for the cache fix?"));
  expect([entering(host), box(host)!.textContent]).toEqual([true, "Wait for the cache fix?"]);
  const appearing = mount(<Shown when appear enter={ENTER} exit={EXIT}><p>Deploy now?</p></Shown>);
  expect(entering(appearing.host)).toBe(true);
});

test("leaving, it keeps what it last showed, out of reach, until its move out ends; then it is gone and says so", async () => {
  slotAnimating("shown", (el) => (el.className.includes("animate-out") ? "exit" : "none"));
  const gone: string[] = [];
  const view = (when: boolean, word: string | null) => (
    <Shown when={when} enter={ENTER} exit={EXIT} onGone={() => gone.push("gone")}>{word && <button type="button">{word}</button>}</Shown>
  );
  const { host, rerender } = mount(view(true, "Tag today"));
  rerender(view(false, null));
  await settle();
  const leaving = box(host)!;
  expect([leaving.textContent, leaving.inert, leaving.className.includes("animate-out"), gone]).toEqual(["Tag today", true, true, []]);
  // Back before it has gone: it is shown again, with what it shows now.
  rerender(view(true, "Wait"));
  expect([box(host)!.textContent, box(host)!.inert]).toEqual(["Wait", false]);
  rerender(view(false, null));
  fireAnimation(box(host)!, "animationend", "exit");
  await settle();
  expect([box(host) === null, gone]).toEqual([true, ["gone"]]);
});

test("with no move to run (less motion asked for), it goes at once; React's double mount is no leave", async () => {
  const gone: string[] = [];
  const view = (when: boolean) => <Shown when={when} enter={ENTER} exit={EXIT} onGone={() => gone.push("gone")}><p>Working…</p></Shown>;
  const { host, rerender } = mount(<StrictMode>{view(true)}</StrictMode>);
  await settle();
  expect(gone).toStrictEqual([]);
  rerender(<StrictMode>{view(false)}</StrictMode>);
  await settle();
  expect([box(host) === null, gone]).toEqual([true, ["gone"]]);
});

test("the focus in it as it starts to leave goes where its owner says, while it can still be moved", async () => {
  slotAnimating("shown", (el) => (el.className.includes("animate-out") ? "exit" : "none"));
  const view = (when: boolean) => (
    <div>
      <textarea aria-label="Composer" />
      <Shown when={when} enter={ENTER} exit={EXIT} onFocusOut={() => document.querySelector<HTMLElement>('[aria-label="Composer"]')!.focus()}>
        <button type="button">Tag today</button>
      </Shown>
    </div>
  );
  const { host, rerender } = mount(view(true));
  host.querySelector<HTMLElement>("button")!.focus();
  rerender(view(false));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Composer");
  // Not when the focus was elsewhere.
  rerender(view(true));
  host.querySelector<HTMLElement>("button")!.blur();
  let moved = 0;
  const { rerender: again } = mount(<Shown when enter={ENTER} exit={EXIT} onFocusOut={() => { moved += 1; }}><p>Working…</p></Shown>);
  again(<Shown when={false} enter={ENTER} exit={EXIT} onFocusOut={() => { moved += 1; }}><p>Working…</p></Shown>);
  expect(moved).toBe(0);
});

test("mounted with nothing to show, it says at once that it is gone", async () => {
  const gone: string[] = [];
  const { host } = mount(<Shown when={false} enter={ENTER} exit={EXIT} onGone={() => gone.push("gone")}><p>Tag today?</p></Shown>);
  await settle();
  expect([box(host) === null, gone]).toEqual([true, ["gone"]]);
});
