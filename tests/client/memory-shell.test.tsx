import { expect, test } from "bun:test";
import { MemoryRouter } from "react-router";
import { MemoryShell } from "@/routes/memory/MemoryShell";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { mountAsync } from "../helpers/mount.js";

/**
 * The Memory page frame: refresh portals into the pane header
 * band, the view switcher is the shared pill strip, and the column is the one
 * every other page uses. happy-dom performs no layout, so the assertions read
 * DOM shape and classes, never boxes.
 */

async function render(): Promise<HTMLElement> {
  const { host } = await mountAsync(
    <MemoryRouter>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <MemoryShell view="overview" setView={() => {}} refreshing={false} onRefresh={() => {}}>
          <div data-x />
        </MemoryShell>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  return host;
}

test("shell: refresh in the header slot, pill nav tabs, no subtitle, redesign column", async () => {
  const el = await render();
  expect(document.querySelectorAll('[data-slot="pane-actions"] button[aria-label="Refresh"]').length).toBe(1);
  expect(el.textContent).not.toContain("What the agent has learned");
  const nav = el.querySelector('nav[data-slot="page-tabs"]')!;
  expect(nav === null).toBe(false);
  expect(Array.from(nav.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Overview", "Activity", "Browse"]);
  expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe("Overview");
  expect(el.innerHTML.includes("border-b-2")).toBe(false);
  const column = el.querySelector('[data-slot="page-column"]')!;
  // The column is the container the overview's two-column grids query.
  expect(column.className.split(/\s+/)).toContain("@container");
  expect(column === null).toBe(false);
  for (const t of ["max-w-[1280px]", "gap-6", "md:px-8"]) expect(column.className.split(/\s+/)).toContain(t);
  // The children still render inside the column.
  expect(column.querySelector("[data-x]") === null).toBe(false);
});

test("shell: the selected pill follows the view prop", async () => {
  const { host } = await mountAsync(
    <MemoryRouter>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <MemoryShell view="browse" setView={() => {}} refreshing={false} onRefresh={() => {}}>
          <div />
        </MemoryShell>
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  const nav = host.querySelector('nav[data-slot="page-tabs"]')!;
  expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe("Browse");
});
