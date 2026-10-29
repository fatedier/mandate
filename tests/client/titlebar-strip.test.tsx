import { afterEach, expect, test } from "bun:test";
import { TITLEBAR_STRIP_HEIGHT, TRAFFIC_LIGHT_CENTRE_Y, TitlebarStrip } from "@/shell/TitlebarStrip";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  // Unmount before the desktop-shell flag the strip reads is removed under it.
  runCleanups();
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

function render() {
  return mount(<TitlebarStrip className="bg-panel" />).host;
}

test("renders nothing in the browser", () => {
  const el = render();
  expect(el.childElementCount).toBe(0);
});

test("desktop shell: a draggable, decorative strip of the documented height", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const el = render();
  const strip = el.querySelector('[data-slot="titlebar-strip"]')!;
  expect(strip === null).toBe(false);
  expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(strip.getAttribute("aria-hidden")).toBe("true");
  expect(strip.className).toContain(`h-[${TITLEBAR_STRIP_HEIGHT}px]`);
  expect(strip.className).toContain("bg-panel");
});

// Tauri's inset is not the lights' top edge: measured on screenshots at
// y = 11, 16 and 18, the visible circles' centre lands at inset.y - 4. The
// lights' centre is 16, so the inset is 20. (The accessibility API's 16px
// button frames sit 2px low of the circles and first misled this to -2.)
const MEASURED_CENTRE_OFFSET = -4;

test("the Tauri window puts the traffic lights at the documented height inside the strip", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const rs = readFileSync(join(import.meta.dir, "..", "..", "src-tauri", "src", "lib.rs"), "utf8");
  const m = rs.match(/traffic_light_position\(tauri::LogicalPosition::new\(([\d.]+), ([\d.]+)\)\)/)!;
  expect(m === null).toBe(false);
  expect(Number(m[2]) + MEASURED_CENTRE_OFFSET).toBe(TRAFFIC_LIGHT_CENTRE_Y);
  // The 12px circles stay inside the strip.
  expect(TRAFFIC_LIGHT_CENTRE_Y + 6).toBeLessThanOrEqual(TITLEBAR_STRIP_HEIGHT);
});
