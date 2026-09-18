import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FeatureActionsMenu } from "@/routes/window/FeatureActionsMenu";
import type { SnapshotWindow } from "@/lib/snapshot-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

test("one menu holds refresh, close and archive, with archive last", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  const win = { windowId: "@1", panes: [] } as unknown as SnapshotWindow;
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <FeatureActionsMenu
          featureId="f1"
          featureName="Alpha"
          window={win}
          onClose={() => {}}
        />
      </MemoryRouter>
    );
  });
  const trigger = host!.querySelector<HTMLButtonElement>('[aria-label="Feature actions"]')!;
  expect(trigger === null).toBe(false);
  // Radix opens on pointerdown, not click.
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim());
  expect(items).toEqual(["Refresh panes", "Close", "Archive feature"]);
  // No bare icon buttons for these actions remain beside the menu.
  expect(host!.querySelector('[aria-label="Close drawer"]') === null).toBe(true);
  expect(host!.querySelector('[aria-label="Refresh panes"]') === null).toBe(true);
});

test("the menu carries Pin to top / Unpin after Refresh, and calls onTogglePin", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  let toggled = 0;
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <FeatureActionsMenu featureId="f1" featureName="Alpha" pinned={false} onTogglePin={() => { toggled += 1; }} onClose={() => {}} />
      </MemoryRouter>
    );
  });
  const trigger = host!.querySelector<HTMLButtonElement>('[aria-label="Feature actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  expect(items.map((n) => n.textContent?.trim())).toEqual(["Refresh panes", "Pin to top", "Close", "Archive feature"]);
  act(() => { items[1]!.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(toggled).toBe(1);
});

test("a pinned feature reads Unpin", async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter>
        <FeatureActionsMenu featureId="f1" featureName="Alpha" pinned={true} onTogglePin={() => {}} onClose={() => {}} />
      </MemoryRouter>
    );
  });
  const trigger = host!.querySelector<HTMLButtonElement>('[aria-label="Feature actions"]')!;
  act(() => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((n) => n.textContent?.trim())).toContain("Unpin");
});
