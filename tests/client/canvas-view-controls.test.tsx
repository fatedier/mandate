import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { CanvasViewMenuItems } from "@/routes/canvas/CanvasViewControls";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { CanvasView, ResolvedCanvasView } from "@/routes/canvas/canvas-view";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";

let host: HTMLElement | null = null;
const realMatchMedia = window.matchMedia;
afterEach(() => {
  // Unmount before the body and matchMedia are reset under the controls.
  runCleanups();
  host = null;
  window.matchMedia = realMatchMedia;
  document.body.innerHTML = "";
});

/** The view items in a menu of their own, as the canvas menu holds them. */
async function render(view: CanvasView, resolved: ResolvedCanvasView, changes: CanvasView[]) {
  host = (await mountAsync(
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Canvas menu">menu</DropdownMenuTrigger>
      <DropdownMenuContent><CanvasViewMenuItems view={view} resolved={resolved} onViewChange={(next) => changes.push(next)} /></DropdownMenuContent>
    </DropdownMenu>
  )).host;
}

async function openMenu() {
  const trigger = host!.querySelector<HTMLButtonElement>('button[aria-label="Canvas menu"]')!;
  // Radix opens menus on pointerdown, not click.
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
}

const item = (name: string) => [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
  .find((el) => (el.getAttribute("aria-label") ?? el.textContent)?.trim() === name);

test("Desktop site shows the zoom it would replace, and turning it on resets zoom to fit", async () => {
  const changes: CanvasView[] = [];
  await render({ desktop: null, zoom: 1.25 }, { desktop: false, zoom: 1.25, fit: false, layoutWidth: 312 }, changes);
  await openMenu();
  expect(document.querySelector("output")!.textContent).toBe("125%");
  const toggle = item("Desktop site")!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => { toggle.click(); });
  expect(changes).toStrictEqual([{ desktop: true, zoom: null }]);
});

test("the zoom menu steps, fits and picks presets", async () => {
  const changes: CanvasView[] = [];
  await render({ desktop: null, zoom: null }, { desktop: true, zoom: 0.5, fit: true, layoutWidth: 1280 }, changes);
  await openMenu();
  await act(async () => { item("Zoom in")!.click(); });
  await act(async () => { item("Zoom out")!.click(); });
  expect(item("Fit width")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => { item("150%")!.click(); });
  expect(changes).toStrictEqual([
    { desktop: null, zoom: 0.67 },
    { desktop: null, zoom: 0.33 },
    { desktop: null, zoom: 1.5 }
  ]);
});

test("Fit width only exists with Desktop site, and 100% is marked when it is the default", async () => {
  await render({ desktop: null, zoom: null }, { desktop: false, zoom: 1, fit: true, layoutWidth: 390 }, []);
  await openMenu();
  expect(item("Fit width") === undefined).toBe(true);
  expect(item("100%")!.getAttribute("aria-checked")).toBe("true");
  expect(item("50%")!.getAttribute("aria-checked")).toBe("false");
  // The checked preset shows in the dark theme too: the selection fill and a
  // heavier weight, not the accent (invisible on the dark popover).
  const checked = item("100%")!.className.split(/\s+/);
  for (const t of ["aria-checked:bg-sel", "aria-checked:text-foreground", "aria-checked:font-semibold"]) expect(checked).toContain(t);
});

test("the view items lead with Desktop site, and turning it off resets zoom", async () => {
  const changes: CanvasView[] = [];
  await render({ desktop: null, zoom: null }, { desktop: true, zoom: 0.3, fit: true, layoutWidth: 1280 }, changes);
  await openMenu();
  const first = document.querySelector<HTMLElement>('[role^="menuitem"]')!;
  expect(first.textContent).toContain("Desktop site");
  expect(first.getAttribute("aria-checked")).toBe("true");
  await act(async () => { first.click(); });
  expect(changes).toStrictEqual([{ desktop: false, zoom: null }]);
});
