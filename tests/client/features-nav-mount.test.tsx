import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { Sidebar } from "@/shell/Sidebar";
import { MobileNav } from "@/shell/MobileNav";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useUIStore } from "@/store/ui";
import type { WorkItemDto } from "@shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The seam between the two shells and FeaturesNavSection — that the section is
 * mounted at all, where in the nav it sits, and that the mobile sheet's close
 * callback reaches it.
 *
 * This file exists because that seam is otherwise silent. The section's own
 * behaviour is covered thoroughly by features-nav-section.test.tsx, which
 * renders the component directly, so dropping the mount from a shell, moving it
 * above the System group or between a band heading and its band, or wiring `onNavigate` to
 * a no-op all left the full suite green — and `tsc` too, since the project runs
 * without `noUnusedLocals` and an orphaned import compiles fine.
 *
 * Presence, order and events only. happy-dom performs no layout, so nothing
 * here may assert width, truncation or visibility.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // All three stores are process-wide singletons shared by every test file in
  // the run, so seeded projects, items, or a collapsed sidebar would otherwise
  // reach whatever file executes next.
  useProjectsStore.setState({ projects: [], byId: {}, bySlug: {} });
  useWorkItemsStore.setState({ items: new Map() });
  useUIStore.setState({ sidebarCollapsed: false });
  // The mobile sheet portals into document.body, outside `host`.
  document.body.innerHTML = "";
});

/** Only the fields the nav path reads. Spelled thin on purpose: `tests/` sits
 *  outside both typecheck gates, so a full DTO here would be unchecked ceremony
 *  rather than safety. Matches the sibling features-nav-section fixture. */
function seed(needsUser: "input" | "review" | null = null) {
  useProjectsStore.setState({
    projects: [
      {
        id: "p1",
        name: "frp",
        tmuxSessionName: "md-frp",
        features: [{ id: "f1", name: "alpha", tmuxWindowName: "w-alpha", pinnedAt: null }]
      }
    ] as never
  });
  useWorkItemsStore.setState({
    items: new Map([["wi-f1", { id: "wi-f1", featureId: "f1", needsUser } as WorkItemDto]]) as never
  });
}

function render(node: React.ReactNode, pathname = "/activity") {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<MemoryRouter initialEntries={[pathname]}>{node}</MemoryRouter>);
  });
  return host!;
}

/** The feature rows anywhere in `el`, in DOM order. Names, not a count: a count
 *  is satisfied just as well by the wrong rows being present. */
function featureRows(el: ParentNode): string[] {
  return Array.from(el.querySelectorAll("[data-feature-name]")).map(
    (n) => (n as HTMLElement).dataset.featureName!
  );
}

/** Every destination link and every band heading in the nav, in DOM order. This
 *  is the whole position assertion.
 *
 *  It reads what a user sees. The nav's two destination clusters carry no
 *  `role="group"` — both names were invisible, so the split was a fact only a
 *  screen reader got — which leaves the links themselves as the anchors, and
 *  they are the better ones: an outline built from invisible markup can agree
 *  with itself while the visible order is wrong.
 *
 *  Links by label, not by `href`: `getSectionUrl` resolves a nav target to the
 *  section's remembered sub-path, and that memory is module-level state shared
 *  across every test in the process, so hrefs are not stable here. The collapsed
 *  rail carries the label in `aria-label` and the expanded row in its first
 *  `span` — the badge is a later sibling, so `querySelector("span")` cannot
 *  reach it.
 *
 *  Band headings have to be in the list. They are bare `aria-hidden` divs with
 *  no role, so a mount landing between a heading and the band it labels would
 *  leave a links-only outline untouched while rows rendered under the wrong
 *  header. A band header is a label span plus a count span; taking the first
 *  element child keeps the count out — the counts are asserted on their own in
 *  features-nav-section.test.tsx, and a position test that moved whenever a
 *  count changed would report the wrong thing.
 *
 *  Feature rows are excluded: they are the variable content, and `featureRows`
 *  is what asserts them. */
function navOutline(el: ParentNode): string[] {
  return Array.from(
    el.querySelectorAll("nav a[href]:not([data-feature-name]), [data-band-head]")
  ).map((n) => {
    if (n.tagName === "A") {
      return `link:${n.getAttribute("aria-label") ?? n.querySelector("span")?.textContent ?? ""}`;
    }
    return `heading:${n.firstElementChild?.textContent ?? n.textContent}`;
  });
}

/** Presence as a boolean, never the node. `expect(node).toBeNull()` serialises
 *  the whole happy-dom element — listener maps plus the parent chain — and
 *  stalls the runner instead of reporting a failure. */
const has = (selector: string) => document.querySelector(selector) !== null;

test("desktop: the features section is mounted last, below the System group", () => {
  seed("input");
  const el = render(<Sidebar />);
  // Mounted at all.
  expect(featureRows(el)).toEqual(["alpha", "alpha"]); // band 1 + band 2
  // And in the right place, which is LAST. It is the only block whose height
  // varies — the Needs you band appears and disappears with the work — so
  // anything below it would shift under the user. Every way of moving the mount
  // keeps all the rows in the DOM and changes only this list, including moving
  // it one element, to above the System group.
  expect(navOutline(el)).toEqual([
    "link:Home",
    "link:Sessions",
    "link:Activity",
    "link:Memory",
    "heading:Needs you",
    "heading:All features",
    "link:Settings"
  ]);
});

test("desktop: the collapsed sidebar carries no feature list, only the Home badge", () => {
  // The count still has to reach the user when the rail is 48px wide; what it
  // must not do is render eleven indistinguishable dots. Dropping the
  // `!collapsed &&` guard is a silent change without this.
  seed("input");
  act(() => useUIStore.setState({ sidebarCollapsed: true }));
  const el = render(<Sidebar />);
  expect(featureRows(el)).toEqual([]);
  // The band headings go with the section, so a collapsed rail has no headings
  // at all — the destinations are the whole outline, in the same order.
  expect(navOutline(el)).toEqual([
    "link:Home",
    "link:Sessions",
    "link:Activity",
    "link:Memory",
    "link:Settings"
  ]);
  // The badge is the collapsed rail's entire report of "one wants you".
  expect(el.textContent).toContain("1");
});

test("mobile: opening the drawer shows the section in the same slot as desktop", () => {
  seed("input");
  render(<MobileNav />);
  openDrawer();
  // The sheet portals outside `host`, so this queries the document.
  expect(featureRows(document.body)).toEqual(["alpha", "alpha"]);
  expect(navOutline(document.body)).toEqual([
    "link:Home",
    "link:Sessions",
    "link:Activity",
    "link:Memory",
    "heading:Needs you",
    "heading:All features",
    "link:Settings"
  ]);
});

test("mobile: tapping a needs-you feature closes the drawer", () => {
  // The only reason `onNavigate` is wired through to the section. Without it
  // the tap navigates and leaves the drawer sitting over the page it just
  // navigated to — and a no-op callback passes every other test in this file.
  //
  // Deliberately a band-1 row, and seeded flagged so band 1 exists: on a phone
  // the whole motion is hamburger, scan "Needs you", tap, so band 1 is the row
  // this path is actually walked on. Band 2's copy of the same prop is a
  // separate call site, covered by features-nav-section.test.tsx.
  seed("input");
  render(<MobileNav />);
  openDrawer();
  expect(has('[data-slot="sheet-content"]')).toBe(true);

  const row = document.querySelector('[data-band="needs"] [data-feature-name="alpha"]');
  expect(row === null).toBe(false);
  act(() => {
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  expect(has('[data-slot="sheet-content"]')).toBe(false);
});

/** Radix opens the sheet from a real click on its trigger — MobileNav holds the
 *  open state in local `useState`, so there is no store to set instead. */
function openDrawer() {
  const trigger = document.querySelector('[aria-label="Open navigation"]');
  if (trigger === null) throw new Error("expected the mobile nav trigger");
  act(() => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
