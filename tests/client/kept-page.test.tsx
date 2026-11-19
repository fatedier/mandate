import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { KeptPage } from "@/shell/KeptPage";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderActions, PaneHeaderSlotsProvider, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useSnapshotStore } from "@/store/snapshot";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// A page kept mounted once opened (the Personal agent's): hidden while
// another page shows, found as it was left on the way back.

afterEach(() => {
  runCleanups();
  useSnapshotStore.getState().setConnection("idle");
});

let go: NavigateFunction = () => {};
function Navigator() {
  go = useNavigate();
  return null;
}

/** A page with something of its own to lose: what was typed, and a frame. */
function Page() {
  const [typed, setTyped] = useState("");
  return (
    <div data-slot="kept-test-page">
      <PaneHeaderTitle><span data-slot="kept-test-title">Juno</span></PaneHeaderTitle>
      <PaneHeaderActions><button type="button" data-slot="kept-test-action">Panel</button></PaneHeaderActions>
      <input aria-label="Draft" value={typed} onChange={(event) => setTyped(event.target.value)} />
      <iframe title="Report" srcDoc="<p>Report</p>" />
    </div>
  );
}

function render(path: string) {
  return mount(
    <MemoryRouter initialEntries={[path]}>
      <Navigator />
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <KeptPage path="/agent"><Page /></KeptPage>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  ).host;
}

const visit = (path: string) => act(() => { void go(path); });
const page = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="kept-test-page"]');

test("a kept page is not made before its first visit", () => {
  const host = render("/home");
  expect(page(host) === null).toBe(true);
  visit("/projects");
  expect(page(host) === null).toBe(true);
  visit("/agent");
  expect(page(host)?.style.display).toBe("");
});

test("another page hides it, and the way back finds the same page as it was left", () => {
  const host = render("/agent");
  const frame = host.querySelector("iframe");
  const draft = host.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    set.call(draft, "half a thought");
    draft.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  visit("/projects");
  expect(page(host)?.style.display).toBe("none");
  visit("/agent");
  expect(page(host)?.style.display).toBe("");
  // The same frame, not one built again, and what was typed.
  expect(host.querySelector("iframe") === frame).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Draft"]')?.value).toBe("half a thought");
});

test("hidden, it leaves the header to the page shown", () => {
  const host = render("/agent");
  expect(host.querySelector('[data-slot="pane-title"] [data-slot="kept-test-title"]') !== null).toBe(true);
  expect(host.querySelector('[data-slot="pane-actions"] [data-slot="kept-test-action"]') !== null).toBe(true);
  visit("/projects");
  // Nothing of it in the header, hidden or not, and the page's own title back.
  expect(host.querySelector('[data-slot="kept-test-title"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="kept-test-action"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="pane-default-title"]')?.textContent).toBe("Projects");
  visit("/agent");
  expect(host.querySelector('[data-slot="pane-title"] [data-slot="kept-test-title"]') !== null).toBe(true);
});
