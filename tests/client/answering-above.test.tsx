import { afterEach, expect, test } from "bun:test";
import { act, useRef, useState } from "react";
import { useAnsweringAbove } from "@/routes/window/chat/useAnsweringAbove";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, settle, type Mounted } from "../helpers/mount.js";

// On a touch screen the composer steps aside while a field above it is typed
// in (a question's answer). It is folded while that field has the focus; a
// tap that began then keeps it as it is until the tap's click has run, so
// nothing moves under the finger, and then it is decided again.

afterEach(() => runCleanups());

function Probe() {
  const region = useRef<HTMLDivElement>(null);
  const answering = useAnsweringAbove(region, true);
  const [folded, setFolded] = useState(false);
  return (
    <div>
      <div ref={region} data-testid="region">
        {folded
          ? <button type="button" data-testid="reminder">1 question</button>
          : <input data-testid="field" />}
        <button type="button" data-testid="send">Send</button>
        <button type="button" data-testid="hide" onClick={() => { setFolded(true); }}>Hide the question</button>
        <p data-testid="text">Which day?</p>
      </div>
      <textarea data-testid="composer" />
      <p data-testid="state">{answering ? "answering" : "idle"}</p>
    </div>
  );
}

const el = <T extends HTMLElement>(view: Mounted, id: string) => view.host.querySelector<T>(`[data-testid="${id}"]`)!;
const state = (view: Mounted) => el(view, "state").textContent;
const fire = (target: HTMLElement, type: string) => act(() => { target.dispatchEvent(new CustomEvent(type, { bubbles: true })); });

test("the field with the focus folds it; the focus anywhere else (the composer, a button) does not", () => {
  const view = mount(<Probe />);
  expect(state(view)).toBe("idle");
  act(() => el(view, "field").focus());
  expect(state(view)).toBe("answering");
  act(() => el(view, "composer").focus());
  expect(state(view)).toBe("idle");
  act(() => el(view, "send").focus());
  expect(state(view)).toBe("idle");
});

// Chrome focuses a tapped button as the finger lands.
test("a tap on Send keeps it folded until its click has run, then it is decided again", async () => {
  const view = mount(<Probe />);
  act(() => el(view, "field").focus());
  fire(el(view, "send"), "pointerdown");
  act(() => el(view, "send").focus());
  fire(el(view, "send"), "pointerup");
  expect(state(view)).toBe("answering");
  fire(el(view, "send"), "click");
  await settle(50);
  expect(state(view)).toBe("idle");
});

// Safari focuses no tapped button: the field loses the focus to nothing in the
// mousedown it sends after the finger is up.
test("a field losing the focus after the finger is up, before the click, keeps it folded until the click", async () => {
  const view = mount(<Probe />);
  act(() => el(view, "field").focus());
  fire(el(view, "send"), "pointerdown");
  fire(el(view, "send"), "pointerup");
  act(() => el(view, "field").blur());
  expect(state(view)).toBe("answering");
  fire(el(view, "send"), "click");
  await settle(50);
  expect(state(view)).toBe("idle");
});

// The field goes with the fold and the focus stays in the region (on the
// reminder): the composer does not stay folded with nothing to type in.
test("hiding the question while its field is typed in brings the composer back", async () => {
  const view = mount(<Probe />);
  act(() => el(view, "field").focus());
  fire(el(view, "hide"), "pointerdown");
  act(() => el(view, "hide").focus());
  fire(el(view, "hide"), "pointerup");
  act(() => el(view, "hide").click());
  act(() => el(view, "reminder").focus());
  await settle(50);
  expect(state(view)).toBe("idle");
});

// The fold's own update lands after the click has run: the field is taken
// away with the focus still on it, and no focus event follows.
test("a fold that takes the typed-in field away brings the composer back", async () => {
  const view = mount(<Probe />);
  act(() => el(view, "field").focus());
  fire(el(view, "hide"), "pointerdown");
  fire(el(view, "hide"), "pointerup");
  fire(el(view, "hide"), "click");
  await settle(50);
  expect(el(view, "reminder")).toBeTruthy();
  expect(state(view)).toBe("idle");
});

test("a touch with no click (a scroll) ends after a moment; the field still typed in keeps it folded", async () => {
  const view = mount(<Probe />);
  act(() => el(view, "field").focus());
  fire(el(view, "text"), "pointerdown");
  fire(el(view, "text"), "pointerup");
  await settle(700);
  expect(state(view)).toBe("answering");
  act(() => el(view, "field").blur());
  expect(state(view)).toBe("idle");
});

test("a tap that began with nothing typed in does not fold it", async () => {
  const view = mount(<Probe />);
  fire(el(view, "send"), "pointerdown");
  act(() => el(view, "send").focus());
  fire(el(view, "send"), "pointerup");
  fire(el(view, "send"), "click");
  await settle(50);
  expect(state(view)).toBe("idle");
});

function Toggle({ active }: { active: boolean }) {
  const region = useRef<HTMLDivElement>(null);
  const answering = useAnsweringAbove(region, active);
  return (
    <div>
      <div ref={region}><input data-testid="field" /></div>
      <p data-testid="state">{answering ? "answering" : "idle"}</p>
    </div>
  );
}

// The question goes while its field had the focus, and a new one comes later:
// the composer is not left folded for a field nobody is typing in.
test("with nothing above the composer it ends, and a new field above starts idle", () => {
  const view = mount(<Toggle active />);
  act(() => el(view, "field").focus());
  expect(state(view)).toBe("answering");
  view.rerender(<Toggle active={false} />);
  expect(state(view)).toBe("idle");
  act(() => el(view, "field").blur());
  view.rerender(<Toggle active />);
  expect(state(view)).toBe("idle");
});
