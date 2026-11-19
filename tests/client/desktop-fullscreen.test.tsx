import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { trackDesktopFullscreen, type FullscreenSource } from "@/shell/desktop-fullscreen";
import { TitlebarStrip } from "@/shell/TitlebarStrip";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  // Unmount and stop the tracker before the desktop-shell flag the strip
  // reads is removed under it.
  runCleanups();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

/** A fake window whose fullscreen state the test flips, and whose resize
 *  events the test fires — the two things Tauri gives us. */
function fakeWindow(initial: boolean) {
  let state = initial;
  let handler: (() => void) | null = null;
  let unlistened = 0;
  const source: FullscreenSource = {
    isFullscreen: () => Promise.resolve(state),
    onResized: (h) => {
      handler = h;
      return Promise.resolve(() => { unlistened += 1; });
    }
  };
  return {
    source,
    set(next: boolean) { state = next; },
    async resize() { handler?.(); await flush(); },
    get unlistened() { return unlistened; }
  };
}

async function flush() {
  // Two microtask hops: the isFullscreen promise, then the set().
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function render() {
  return mount(<TitlebarStrip />).host;
}

const strip = (el: HTMLElement) => el.querySelector('[data-slot="titlebar-strip"]');

test("desktop: the strip hides when the window enters fullscreen and returns when it leaves", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const win = fakeWindow(false);
  onCleanup(trackDesktopFullscreen(win.source));
  await flush();
  const el = render();
  expect(strip(el) === null).toBe(false);

  win.set(true);
  await win.resize();
  expect(strip(el) === null).toBe(true);

  win.set(false);
  await win.resize();
  expect(strip(el) === null).toBe(false);
});

test("desktop: a window that boots already in fullscreen never shows the strip", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const win = fakeWindow(true);
  onCleanup(trackDesktopFullscreen(win.source));
  await flush();
  const el = render();
  expect(strip(el) === null).toBe(true);
});

test("teardown unsubscribes from resize and resets the state", async () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const win = fakeWindow(true);
  const teardown = trackDesktopFullscreen(win.source);
  await flush();
  teardown();
  expect(win.unlistened).toBe(1);
  const el = render();
  // Reset to "not fullscreen": the strip is back for the next tracker.
  expect(strip(el) === null).toBe(false);
});
