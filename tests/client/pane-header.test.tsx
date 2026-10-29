import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactNode } from "react";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderActions, PaneHeaderSlotsProvider, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { TopBar } from "@/shell/TopBar";
import { useSnapshotStore } from "@/store/snapshot";
import { fakePhoneWidth } from "../fake-phone-width";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, type Mounted } from "../helpers/mount.js";
import { realClock } from "../helpers/fake-clock.js";

let view: Mounted | null = null;

afterEach(() => {
  // Unmount before the connection the header reads is reset under it.
  runCleanups();
  useSnapshotStore.getState().setConnection("idle");
  realClock();
});

function render(pathname: string, page: ReactNode = null) {
  view = mount(
    <MemoryRouter initialEntries={[pathname]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes>
          <Route path="*" element={page} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  return view.host;
}

test("a route without a title renders the breadcrumb's current segment", () => {
  const el = render("/activity");
  const title = el.querySelector('[data-slot="pane-default-title"]');
  expect(title?.textContent).toBe("Activity");
  expect(el.querySelector('[data-slot="pane-header"]')?.hasAttribute("data-tauri-drag-region")).toBe(true);
});

test("a route that claims the title replaces the default", () => {
  const el = render(
    "/activity",
    <PaneHeaderTitle>
      <span data-testid="custom">Custom title</span>
    </PaneHeaderTitle>
  );
  expect(el.querySelector('[data-slot="pane-default-title"]') === null).toBe(true);
  expect(el.querySelector('[data-slot="pane-title"] [data-testid="custom"]')?.textContent).toBe("Custom title");
});

test("route actions land in the header's actions slot", () => {
  const el = render(
    "/activity",
    <PaneHeaderActions>
      <button type="button" aria-label="Do thing" />
    </PaneHeaderActions>
  );
  expect(el.querySelector('[data-slot="pane-actions"] [aria-label="Do thing"]') === null).toBe(false);
});

test("TopBar renders nothing on desktop", () => {
  const { host } = mount(
    <MemoryRouter initialEntries={["/activity"]}>
      <PaneHeaderSlotsProvider>
        <TopBar />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  expect(host.childElementCount).toBe(0);
});

// The live stream's state is said in the header, after the page's title — as
// a document's title carries "Trying to connect" — covering nothing.

function renderPhone(pathname: string, page: ReactNode = null) {
  return mount(
    <MemoryRouter initialEntries={[pathname]}>
      <PaneHeaderSlotsProvider>
        <TopBar />
        <Routes>
          <Route path="*" element={page} />
        </Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  ).host;
}

const note = (el: HTMLElement) => el.querySelector('[data-slot="connection-indicator"]');
// A header's children as drawn: its slots hide themselves while empty.
const drawn = (header: Element) => [...header.children]
  .filter((c) => !(c.matches('[data-slot="pane-title"], [data-slot="pane-actions"]') && c.childElementCount === 0))
  .map((c) => c.getAttribute("data-slot") ?? c.getAttribute("aria-label"));
const setConnection = (connection: "open" | "error") => act(() => { useSnapshotStore.getState().setConnection(connection); });
function dropStream(ms: number) {
  setConnection("error");
  act(() => { jest.advanceTimersByTime(ms); });
}

test("the header says Reconnecting… after its title once the stream has been down 2s, and stops when it is back", () => {
  jest.useFakeTimers();
  const el = render("/activity", <PaneHeaderActions><button type="button" aria-label="Do thing" /></PaneHeaderActions>);
  dropStream(1999);
  expect(note(el) === null).toBe(true);
  act(() => { jest.advanceTimersByTime(1); });
  const said = note(el)!;
  // Read out once (the screen reader's copy); the word on screen is hidden from it.
  expect(said.querySelector(".sr-only")?.textContent).toBe("Reconnecting…");
  expect(said.querySelector('[data-slot="connection-word"]')?.closest('[aria-hidden="true"]') === null).toBe(false);
  expect(said.querySelector('[data-slot="connection-word"]')?.textContent?.trim()).toBe("Reconnecting…");
  expect(said.getAttribute("role")).toBe("status");
  // In the header, straight after the title, which is all still there.
  const title = el.querySelector('[data-slot="pane-default-title"]')!;
  expect(title.textContent).toBe("Activity");
  expect(said.closest('[data-slot="pane-header"]') === null).toBe(false);
  const order = drawn(el.querySelector('[data-slot="pane-header"]')!);
  expect(order.indexOf("connection-indicator")).toBe(order.indexOf("pane-default-title") + 1);
  expect(el.querySelector('[data-slot="pane-actions"] [aria-label="Do thing"]') === null).toBe(false);
  setConnection("open");
  expect(note(el) === null).toBe(true);
  // Down again: it waits its 2s again, whatever it said last time.
  dropStream(1999);
  expect(note(el) === null).toBe(true);
  act(() => { jest.advanceTimersByTime(1); });
  expect(note(el) === null).toBe(false);
});

test("a stream that comes back within 2s never says it was gone", () => {
  jest.useFakeTimers();
  const el = render("/activity");
  dropStream(1500);
  setConnection("open");
  act(() => { jest.advanceTimersByTime(5000); });
  expect(note(el) === null).toBe(true);
  // Down again: the 2s start over.
  dropStream(1999);
  expect(note(el) === null).toBe(true);
});

test("a title a page claims is followed by it too", () => {
  jest.useFakeTimers();
  const el = render("/activity", <PaneHeaderTitle><span data-testid="custom">project-1 3.21 release</span></PaneHeaderTitle>);
  dropStream(2000);
  const order = drawn(el.querySelector('[data-slot="pane-header"]')!);
  expect(order.indexOf("connection-indicator")).toBe(order.indexOf("pane-title") + 1);
  expect(el.querySelector('[data-slot="pane-title"] [data-testid="custom"]')?.textContent).toBe("project-1 3.21 release");
});

test("on a phone it follows the top bar's title", () => {
  onCleanup(fakePhoneWidth(390));
  jest.useFakeTimers();
  const el = renderPhone("/activity");
  dropStream(2000);
  const bar = el.querySelector("header")!;
  const order = drawn(bar);
  expect(order.indexOf("connection-indicator")).toBe(order.indexOf("Breadcrumb") + 1);
  expect(bar.querySelector('nav[aria-label="Breadcrumb"]')!.textContent).toContain("Activity");
});

test("a header mounted mid-outage says it at once: the outage's 2s are not restarted", () => {
  // A phone turned past the breakpoint swaps the top bar for the pane header.
  jest.useFakeTimers();
  const first = render("/activity");
  dropStream(2000);
  expect(note(first) === null).toBe(false);
  view!.unmount();
  const second = render("/activity");
  expect(note(second) === null).toBe(false);
});

test("a retry that fails again during the outage does not restart its 2s", () => {
  jest.useFakeTimers();
  const el = render("/activity");
  dropStream(1500);
  setConnection("error");
  act(() => { jest.advanceTimersByTime(500); });
  expect(note(el) === null).toBe(false);
});
