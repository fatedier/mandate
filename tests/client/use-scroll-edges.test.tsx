import { expect, test } from "bun:test";
import { act } from "react";
import { createPortal } from "react-dom";
import { useScrollEdges } from "@/hooks/useScrollEdges";
import { mount } from "../helpers/mount.js";

// A focus inside a portal that belongs to the row's React tree (an open
// select's options) bubbles to the row's handler, though it is not in the
// row: its offsets are the popup's, not the row's, and must not scroll it.

function Row() {
  const { ref, onFocus } = useScrollEdges<HTMLDivElement>();
  return (
    <div ref={ref} data-slot="row" onFocus={onFocus}>
      <button type="button" data-slot="inside">Source</button>
      {createPortal(<button type="button" data-slot="option">Agent</button>, document.body)}
    </div>
  );
}

test("a focus from a portal outside the row leaves the row's scroll where it is", () => {
  const { host } = mount(<Row />);
  const row = host.querySelector<HTMLElement>('[data-slot="row"]')!;
  let left = 102;
  Object.defineProperty(row, "clientWidth", { configurable: true, get: () => 358 });
  Object.defineProperty(row, "scrollWidth", { configurable: true, get: () => 728 });
  Object.defineProperty(row, "scrollLeft", { configurable: true, get: () => left, set: (x: number) => { left = x; } });
  const option = document.querySelector<HTMLElement>('[data-slot="option"]')!;
  Object.defineProperty(option, "offsetLeft", { configurable: true, get: () => 0 });
  Object.defineProperty(option, "offsetWidth", { configurable: true, get: () => 120 });
  (option as unknown as { matches: (selector: string) => boolean }).matches = (selector) => selector === ":focus-visible" || Element.prototype.matches.call(option, selector);
  act(() => { option.dispatchEvent(new window.FocusEvent("focusin", { bubbles: true })); });
  expect(left).toBe(102);
});
