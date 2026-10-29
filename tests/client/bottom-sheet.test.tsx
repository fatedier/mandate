import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { runCleanups } from "../helpers/cleanup.js";
import { mount, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;
afterEach(() => {
  // Unmount before the body is cleared under the sheet.
  runCleanups();
  view = null;
  // The sheet portals into document.body, outside its host.
  document.body.innerHTML = "";
});

/** The first call in a test mounts; later ones render into the same root. */
function show(node: ReactNode) {
  if (view) view.rerender(node);
  else view = mount(node);
}

function render(open: boolean, opts: { headerButton?: boolean } = {}) {
  show(
    <BottomSheet
      open={open}
      onOpenChange={() => {}}
      header={<><BottomSheetTitle>Ran 3 commands</BottomSheetTitle>{opts.headerButton !== false && <button type="button">Close</button>}</>}
    >
      <p>What the calls returned</p>
      <button type="button" data-testid="row">A call below the fold</button>
    </BottomSheet>
  );
}

const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]');
const body = () => document.querySelector('[data-slot="bottom-sheet-body"]')!.className.split(/\s+/);
// vaul cycles on a tap after a short wait, to tell a tap from a double tap.
const tapHandle = () => act(async () => {
  document.querySelector<HTMLElement>("[data-vaul-handle]")!.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test("a sheet opens at half height, its content held still so a drag moves the sheet", () => {
  render(true);
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
  expect(body()).toContain("overflow-hidden");
  expect(body()).not.toContain("overflow-y-auto");
});

test("pulled up by its handle, the sheet takes the screen and its content scrolls", async () => {
  render(true);
  await tapHandle();
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  expect(body()).toContain("overflow-y-auto");
});

test("a sheet left pulled up opens at half again next time", async () => {
  render(true);
  await tapHandle();
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
  render(false);
  render(true);
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
});

test("the title names the dialog", () => {
  render(true);
  const labelledBy = sheet()!.getAttribute("aria-labelledby")!;
  expect(document.getElementById(labelledBy)?.textContent).toBe("Ran 3 commands");
});

test("opening moves focus onto the sheet itself, off the page it covers", async () => {
  render(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(document.activeElement === sheet()).toBe(true);
});

test("opening stays at half even when the only focusable things are in the body", async () => {
  // The pane switcher: no button in its header, rows in its body. Focus that
  // landed on a row would read as moving into the content and pull it up.
  render(true, { headerButton: false });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(sheet()?.getAttribute("data-expanded")).toBe("false");
});

test("a scrolled sheet comes back to half at the top of its content", async () => {
  render(true);
  await tapHandle();
  const scroller = document.querySelector<HTMLElement>('[data-slot="bottom-sheet-body"]')!;
  scroller.scrollTop = 240;
  render(false);
  render(true);
  expect(document.querySelector<HTMLElement>('[data-slot="bottom-sheet-body"]')!.scrollTop).toBe(0);
});

test("focus reaching the content from the keyboard pulls the sheet up", () => {
  // At half the content cannot scroll, and the handle takes no focus, so a
  // keyboard or switch user's only way to what is below is to move into it.
  // (happy-dom counts every focus as :focus-visible, so that a tap does not
  // do this is checked in a browser, in e2e/tool-run.test.ts.)
  render(true);
  act(() => { document.querySelector<HTMLElement>('[data-testid="row"]')!.focus(); });
  expect(sheet()?.getAttribute("data-expanded")).toBe("true");
});

test("the bottom safe area survives whatever padding a caller gives the body", () => {
  // Both callers pad the body's bottom; on the same element that padding
  // replaced the safe-area inset and left the last row under the home bar.
  show(
    <BottomSheet open onOpenChange={() => {}} bodyClassName="px-2 pb-4" header={<BottomSheetTitle>Switch pane</BottomSheetTitle>}>
      <p>rows</p>
    </BottomSheet>
  );
  const insetOn = (el: Element | null) => (el?.className ?? "").split(/\s+/).includes("pb-[env(safe-area-inset-bottom)]");
  const body = document.querySelector('[data-slot="bottom-sheet-body"]')!;
  expect(body.className.split(/\s+/)).toContain("pb-4");
  expect(insetOn(sheet()) || insetOn(body)).toBe(true);
});
