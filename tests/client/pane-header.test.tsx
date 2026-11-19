import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ReactNode } from "react";
import { PaneHeader } from "@/shell/PaneHeader";
import { ChatPaneHeader, PaneHeaderActions, PaneHeaderSlotsProvider, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { PanelTabRow } from "@/components/PanelTabRow";
import { TopBar } from "@/shell/TopBar";
import { useSnapshotStore } from "@/store/snapshot";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount, type Mounted } from "../helpers/mount.js";

let view: Mounted | null = null;

afterEach(() => {
  // Unmount before the connection the header reads is reset under it.
  runCleanups();
  useSnapshotStore.getState().setConnection("idle");
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

// A chat page with a panel beside it holds its header in the chat's pane, in
// the chat's column, so its title and actions sit over the conversation and
// the panel's tabs take the band over the panel.
test("a chat pane's header takes the band: the shell's goes, and the route's title and actions land in the chat's column", () => {
  const page = (hosted: boolean) => (
    <>
      <PaneHeaderTitle><span data-testid="custom">Release 3.21</span></PaneHeaderTitle>
      <PaneHeaderActions><button type="button" aria-label="Do thing" /></PaneHeaderActions>
      {hosted && <div data-testid="chat-pane"><ChatPaneHeader /></div>}
    </>
  );
  const el = render("/threads/thr_1", page(true));
  const headers = el.querySelectorAll('[data-slot="pane-header"]');
  expect(headers.length).toBe(1);
  const header = headers[0]!;
  expect(header.closest('[data-testid="chat-pane"]') !== null).toBe(true);
  expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(header.querySelector('[data-slot="pane-title"] [data-testid="custom"]')?.textContent).toBe("Release 3.21");
  expect(header.querySelector('[data-slot="pane-actions"] [aria-label="Do thing"]') !== null).toBe(true);
  // The row is the chat's column: as wide as the transcript at most, centred,
  // inside the chat's own gutters.
  const row = header.querySelector<HTMLElement>('[data-slot="pane-header-row"]')!;
  expect([row.style.maxWidth, row.className.split(/\s+/).includes("mx-auto")]).toEqual(["880px", true]);
  expect(header.className).toContain("px-(--chat-gutter)");
  // Gone again, the shell's band is back with the route's title in it.
  view!.rerender(
    <MemoryRouter initialEntries={["/threads/thr_1"]}>
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <Routes><Route path="*" element={page(false)} /></Routes>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  const back = el.querySelectorAll('[data-slot="pane-header"]');
  expect(back.length).toBe(1);
  expect(back[0]!.closest('[data-testid="chat-pane"]') === null).toBe(true);
  expect(back[0]!.querySelector('[data-slot="pane-title"] [data-testid="custom"]')?.textContent).toBe("Release 3.21");
});

test("beside a chat pane's header, a panel's tab row is the band's height and drags the window; without one it keeps its own row", () => {
  const row = (hosted: boolean) => {
    const el = render("/agent", (
      <>
        {hosted && <ChatPaneHeader />}
        <PanelTabRow first={{ label: "Page" }} tabs={[]} active="first" onSelect={() => {}} tools={null} ariaLabel="Page tabs" />
      </>
    ));
    const tabs = el.querySelector('[role="tablist"][aria-label="Page tabs"]')!.parentElement!;
    const seen = [tabs.className.split(/\s+/).includes("h-13"), tabs.className.split(/\s+/).includes("h-11"), tabs.hasAttribute("data-tauri-drag-region")];
    runCleanups();
    view?.unmount();
    return seen;
  };
  expect(row(true)).toEqual([true, false, true]);
  expect(row(false)).toEqual([false, true, false]);
});
