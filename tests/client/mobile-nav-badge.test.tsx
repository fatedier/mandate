import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { MobileNav } from "@/shell/MobileNav";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import type { WorkItemDto } from "@shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The hamburger is the only standing signal a phone has: there is no sidebar
 *  at all below the breakpoint and the drawer must be summoned, so nothing
 *  inside it can be scanned. These assert the count reaches the *closed*
 *  trigger — not how it is positioned, which needs layout happy-dom does not do.
 *
 *  Sibling coverage: features-nav-mount.test.tsx renders the same component but
 *  always opens the sheet and asserts the rows inside it; the closed trigger is
 *  only this file's subject. Store seeding and the render helper are kept in the
 *  same shape as that file on purpose. */

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // Both stores are process-wide singletons shared by every test file in the
  // run, so seeded projects or items would otherwise reach whatever file
  // executes next.
  useProjectsStore.setState({ projects: [], byId: {}, bySlug: {} });
  useWorkItemsStore.setState({ items: new Map() });
  document.body.innerHTML = "";
});

/** `flagged` of three features need the user. The fixture has to vary in all
 *  three dimensions the count is defined by, or a wrong badge still passes:
 *
 *  1. Not the feature count — three features, `flagged` of them flagged, so a
 *     badge rendering `features.length` is wrong and fails.
 *  2. Not zero — the count test flags two.
 *  3. Not the work-item count. This is why every feature gets an item and the
 *     unflagged ones carry `needsUser: null` rather than no item at all. With
 *     items only for the flagged features `items.size` equals the count in
 *     both tests, so a badge wired to the raw store size passes, and
 *     `selectAttentionFeatures`'s `needsUser === null` skip is never
 *     exercised. `items.size` is 3 in both tests now; the count is 2 and 0.
 *     Mirrors features-nav-mount.test.tsx, which parameterizes `needsUser`
 *     over the same three values.
 *
 *  Only the fields the attention path reads — `tests/` sits outside both
 *  typecheck gates, so a full DTO here would be unchecked ceremony rather than
 *  safety. */
function seed(flagged: number) {
  const features = Array.from({ length: 3 }, (_, i) => ({
    id: `f${i}`,
    name: `feat-${i}`,
    tmuxWindowName: `w-${i}`,
    pinnedAt: null
  }));
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "frp", tmuxSessionName: "md-frp", features }] as never
  });
  const items = features.map(
    (f, i) =>
      ({
        id: `wi-${f.id}`,
        featureId: f.id,
        needsUser: i < flagged ? "input" : null
      }) as unknown as WorkItemDto
  );
  useWorkItemsStore.setState({ items: new Map(items.map((i) => [i.id, i])) as never });
}

/** Renders the nav with the sheet shut and returns the trigger button. */
function renderNav() {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={["/activity"]}>
        <MobileNav />
      </MemoryRouter>
    );
  });
  const trigger = host!.querySelector('[aria-label="Open navigation"]');
  if (trigger === null) throw new Error("expected the mobile nav trigger");
  return trigger as HTMLElement;
}

test("the closed trigger carries the attention count", () => {
  seed(2);
  const trigger = renderNav();
  expect(trigger.textContent).toContain("2");
  // And it is the badge carrying it, not some other "2" that happens to be in
  // the button: the label names what the number means.
  const badge = trigger.querySelector('[aria-label="2 items need you"]');
  expect(badge === null).toBe(false);
});

test("the closed trigger shows no badge when nothing wants you", () => {
  seed(0);
  // The drawer is shut, so this is the whole of what a phone reports. A "0"
  // here would be a standing line that says nothing.
  const trigger = renderNav();
  expect(trigger.textContent).not.toContain("0");
  // Suppression is AttentionBadge's own `count <= 0` guard, and only that: the
  // call site renders the badge unconditionally, so this test reddens when that
  // guard is mutated. A second `> 0` at the call site would mask it.
  // `*=` not `$=`: the label is "needs you" at one and "need you" above one, so
  // an ends-with match would miss the singular badge it is here to exclude.
  expect(trigger.querySelector("[aria-label*='need']") === null).toBe(true);
});
