import { afterEach, expect, test } from "bun:test";
import { act, useContext, useEffect } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { KeptAlivePage } from "@/shell/KeptAlivePage";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { PageShownContext } from "@/lib/page-shown";
import { useSnapshotStore } from "@/store/snapshot";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// A page kept running for a while after it is left (the Terminals page, so
// its connections stay open): hidden, its effects going on, until it is let
// go a set time after it was left.

afterEach(() => {
  runCleanups();
  useSnapshotStore.getState().setConnection("idle");
});

let go: NavigateFunction = () => {};
function Navigator() {
  go = useNavigate();
  return null;
}

let started = 0;
let stopped = 0;
let shownInside: boolean | null = null;
/** A page whose effect stands for what it keeps open (a connection). */
function Page() {
  shownInside = useContext(PageShownContext);
  useEffect(() => {
    started += 1;
    return () => { stopped += 1; };
  }, []);
  return (
    <div data-slot="alive-test-page">
      <PaneHeaderTitle><span data-slot="alive-test-title">Tabs</span></PaneHeaderTitle>
    </div>
  );
}

const KEEP_MS = 80;
function render(path: string) {
  started = 0;
  stopped = 0;
  shownInside = null;
  return mount(
    <MemoryRouter initialEntries={[path]}>
      <Navigator />
      <PaneHeaderSlotsProvider>
        <PaneHeader />
        <KeptAlivePage paths={["/terminals", "/terminals/pane/:paneId"]} keepMs={KEEP_MS}><Page /></KeptAlivePage>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  ).host;
}

const visit = (path: string) => act(() => { void go(path); });
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const page = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="alive-test-page"]');
const layer = (host: HTMLElement) => page(host)?.parentElement ?? null;

test("a kept-alive page is not made before its first visit", () => {
  const host = render("/home");
  expect(page(host) === null).toBe(true);
  visit("/terminals/pane/%251");
  expect(page(host) === null).toBe(false);
});

test("left, it goes on running, hidden where it was and out of reach", () => {
  const host = render("/terminals/pane/%251");
  expect(shownInside).toBe(true);
  visit("/projects");
  expect({ started, stopped }).toEqual({ started: 1, stopped: 0 });
  expect(shownInside).toBe(false);
  expect(layer(host)?.className).toContain("invisible");
  expect(layer(host)?.hasAttribute("inert")).toBe(true);
});

test("hidden, it leaves the header to the page shown, its default title too", () => {
  const host = render("/terminals");
  expect(host.querySelector('[data-slot="pane-title"] [data-slot="alive-test-title"]') !== null).toBe(true);
  visit("/projects");
  expect(host.querySelector('[data-slot="alive-test-title"]') === null).toBe(true);
  expect(host.querySelector('[data-slot="pane-default-title"]')?.textContent).toBe("Projects");
});

test("back before it is let go, it is the same page, shown, and kept on", async () => {
  const host = render("/terminals");
  visit("/projects");
  await wait(KEEP_MS / 4);
  visit("/terminals/pane/%252");
  expect(layer(host)?.className).not.toContain("invisible");
  expect(layer(host)?.hasAttribute("inert")).toBe(false);
  await wait(KEEP_MS * 2);
  expect({ started, stopped }).toEqual({ started: 1, stopped: 0 });
});

test("left longer than it is kept, it is let go; the next visit starts it again", async () => {
  const host = render("/terminals");
  visit("/projects");
  await wait(KEEP_MS * 2);
  expect(page(host) === null).toBe(true);
  expect({ started, stopped }).toEqual({ started: 1, stopped: 1 });
  visit("/terminals");
  expect(page(host) === null).toBe(false);
  expect(started).toBe(2);
});
