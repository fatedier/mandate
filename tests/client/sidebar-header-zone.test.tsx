import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Sidebar } from "@/shell/Sidebar";
import { useUIStore } from "@/store/ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  act(() => useUIStore.setState({ sidebarCollapsed: false }));
});

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/activity"]}>
        <Sidebar />
      </MemoryRouter>
    );
  });
  return host!;
}

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function withDesktopShell(run: () => void) {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  try {
    run();
  } finally {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  }
}

test("the header zone carries the brand and the collapse toggle, and nothing reserved for the traffic lights", () => {
  const el = render();
  const zone = el.querySelector('[data-slot="sidebar-header"]')!;
  expect(zone.hasAttribute("data-tauri-drag-region")).toBe(true);
  expect(zone.querySelector('[data-slot="brand"]')?.textContent).toContain("Mandate");
  expect(zone.querySelector('[aria-label="Collapse sidebar"]') === null).toBe(false);
  expect(el.querySelector('[data-slot="traffic-light-spacer"]') === null).toBe(true);
});

test("browser: no title strip above the header zone", () => {
  const el = render();
  expect(el.querySelector('[data-slot="titlebar-strip"]') === null).toBe(true);
  expect(el.querySelector("aside")!.firstElementChild?.getAttribute("data-slot")).not.toBe("titlebar-strip");
});

test("desktop shell: the traffic lights' strip is the sidebar's first child and the header zone below is the browser's", () => {
  withDesktopShell(() => {
    const el = render();
    const aside = el.querySelector("aside")!;
    const strip = aside.querySelector('[data-slot="titlebar-strip"]')!;
    expect(strip === null).toBe(false);
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(strip.className).toContain("h-[28px]");
    // First child, so the lights sit above the brand row, not beside it.
    const children = Array.from(aside.children).filter((c) => c.getAttribute("role") !== "separator");
    expect(children[0]).toBe(strip);
    expect(children[1]?.getAttribute("data-slot")).toBe("sidebar-header");
    const zone = aside.querySelector('[data-slot="sidebar-header"]')!;
    expect(zone.querySelector('[data-slot="brand"]')?.textContent).toContain("Mandate");
    expect(zone.querySelector('[aria-label="Collapse sidebar"]') === null).toBe(false);
  });
});

test("collapsed, both shells: the expand toggle sits in the header band, level with the pane titles", () => {
  for (const desktop of [false, true]) {
    const check = () => {
      act(() => useUIStore.setState({ sidebarCollapsed: true }));
      const el = render();
      const zone = el.querySelector('[data-slot="sidebar-header"]')!;
      expect(zone.querySelector('[data-slot="brand"]') === null).toBe(true);
      // In the band, and only there — a second copy in the nav would leave the
      // rail with a blank hole above a duplicated button.
      expect(zone.querySelector('[aria-label="Expand sidebar"]') === null).toBe(false);
      expect(el.querySelector('nav [aria-label="Expand sidebar"]') === null).toBe(true);
      expect((el.querySelector('[data-slot="titlebar-strip"]') === null)).toBe(!desktop);
      act(() => root?.unmount());
      host?.remove();
    };
    if (desktop) withDesktopShell(check);
    else check();
  }
});

test("the stylesheet no longer keys any layout on the desktop shell", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const css = readFileSync(join(import.meta.dir, "..", "..", "src", "client", "styles", "globals.css"), "utf8");
  // Both earlier desktop layouts lived here (a hidden brand, then a 68px
  // spacer and a wider collapsed rail). The strip replaced them.
  expect(css).not.toContain('[data-shell="desktop"] [data-slot');
  expect(css).not.toContain('[data-shell="desktop"] aside');
  expect(css).not.toContain("traffic-light-spacer");
});
