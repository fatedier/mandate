import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";

afterEach(() => runCleanups());

/** Every element scrollIntoView was called on, and how. Restored from its
 *  captured descriptor after the test. */
function recordScrolls() {
  const calls: Array<{ el: Element; options: unknown }> = [];
  const saved = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true, writable: true,
    value(this: Element, options?: unknown) { calls.push({ el: this, options }); }
  });
  onCleanup(() => {
    if (saved) Object.defineProperty(Element.prototype, "scrollIntoView", saved);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  return calls;
}

// A dialog that scrolls (taller than a short screen) can be handed focus
// without a scroll: Radix wraps Tab from the last control to the first with
// preventScroll. Whatever gains focus inside any dialog is scrolled into view.
test("whatever gains focus inside a dialog is scrolled into view, the nearest way", async () => {
  const calls = recordScrolls();
  await mountAsync(
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Tall</DialogTitle>
        <input aria-label="first" />
        <button type="button">last</button>
      </DialogContent>
    </Dialog>
  );
  await settle();
  // The dialog opened with its first field focused; move on to the button.
  calls.length = 0;
  const last = [...document.querySelectorAll("button")].find((b) => b.textContent === "last")!;
  act(() => last.focus());
  expect(calls.map((c) => [c.el === last, c.options])).toStrictEqual([[true, { block: "nearest" }]]);
});

test("a dialog's own onFocus still runs", async () => {
  recordScrolls();
  let seen = 0;
  await mountAsync(
    <Dialog open>
      <DialogContent aria-describedby={undefined} onFocus={() => { seen += 1; }}>
        <DialogTitle>Tall</DialogTitle>
        <input aria-label="first" />
        <button type="button">last</button>
      </DialogContent>
    </Dialog>
  );
  await settle();
  seen = 0;
  act(() => [...document.querySelectorAll("button")].find((b) => b.textContent === "last")!.focus());
  expect(seen).toBe(1);
});
