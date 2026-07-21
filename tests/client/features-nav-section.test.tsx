import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FeaturesNavSection } from "@/shell/FeaturesNavSection";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import type { WorkItemDto } from "@shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the section says, not how it looks. happy-dom performs no layout, so
 * truncation and width belong in e2e. What belongs here: which rows reach the
 * DOM, which band they land in, and which project group they sit under — a
 * feature name is unique only within its project (`idx_features_active_name`
 * is unique on `(project_id, name)` among unarchived rows), so two live
 * features in different projects may carry the same name and a bare name
 * assertion proves nothing.
 */

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // Both stores are process-wide singletons and every test file shares one
  // process, so seeded projects/items would otherwise reach later files.
  useProjectsStore.setState({ projects: [], byId: {}, bySlug: {} });
  useWorkItemsStore.setState({ items: new Map() });
});

function proj(id: string, name: string, slug: string, features: Array<[string, string, string?]>) {
  return {
    id,
    name,
    tmuxSessionName: slug,
    features: features.map(([fid, fname, pinnedAt]) => ({
      id: fid,
      name: fname,
      tmuxWindowName: `w-${fname}`,
      pinnedAt: pinnedAt ?? null
    }))
  };
}

function wi(featureId: string, needsUser: "input" | "review" | null): WorkItemDto {
  return { id: `wi-${featureId}`, featureId, needsUser } as unknown as WorkItemDto;
}

function render(pathname: string, props: { onNavigate?: () => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <MemoryRouter initialEntries={[pathname]}>
        <FeaturesNavSection {...props} />
      </MemoryRouter>
    );
  });
  return host!;
}

/** The feature names one band renders, in DOM order. */
function bandRows(el: HTMLElement, band: "needs" | "all"): string[] {
  const section = el.querySelector(`[data-band="${band}"]`);
  if (!section) return [];
  return Array.from(section.querySelectorAll("[data-feature-name]")).map(
    (n) => (n as HTMLElement).dataset.featureName!
  );
}

/** Every row of one band as an [featureName, aria-current] pair, in DOM order.
 *  Pairs, never a count: with several rows present, "exactly one row is
 *  current" is satisfied just as well by the wrong row being the one. */
function bandCurrent(el: HTMLElement, band: "needs" | "all"): Array<[string, string | null]> {
  return Array.from(el.querySelectorAll(`[data-band="${band}"] [data-feature-name]`)).map((n) => [
    (n as HTMLElement).dataset.featureName!,
    n.getAttribute("aria-current")
  ]);
}

/** Every row of one band as a [featureName, urgency-label] pair, in DOM order.
 *  The dot is the only place urgency is stated, so this is the only handle on
 *  it that is not a colour. */
function bandUrgency(el: HTMLElement, band: "needs" | "all"): Array<[string, string | null]> {
  return Array.from(el.querySelectorAll(`[data-band="${band}"] [data-feature-name]`)).map((n) => [
    (n as HTMLElement).dataset.featureName!,
    n.querySelector('[role="img"]')?.getAttribute("aria-label") ?? null
  ]);
}

/** Every row of one band as a [featureName, project-label] pair, in DOM order.
 *  Band 2 states the project once, as a group heading; band 1 is FLAT and has
 *  no heading at all, so the label on the row is that band's only statement of
 *  which project a row belongs to — and a feature name is unique only within
 *  its project, so the name on its own identifies nothing.
 *
 *  The row is a dot, a name, and — only when the row was given a project — a
 *  trailing label. Read by position, not by class: the class is styling, and
 *  what is under test is whether the element is rendered at all. `null` is a
 *  row that renders no such element. */
function bandNameAndProject(
  el: HTMLElement,
  band: "needs" | "all"
): Array<[string, string | null]> {
  return Array.from(el.querySelectorAll(`[data-band="${band}"] [data-feature-name]`)).map((n) => {
    const row = n as HTMLElement;
    return [
      row.dataset.featureName!,
      row.children.length === 3 ? row.children[2]!.textContent : null
    ];
  });
}

/** Every row of one band as a [featureName, framed] pair, in DOM order. A frame
 *  means this one wants you, and `border` is the class that draws it — the rest
 *  of the row's classes are layout or colour, and `border-border` is the hue
 *  rather than the frame. A class is an attribute, so this is readable in
 *  happy-dom; whether the frame is *visible* is an e2e question. */
function bandFramed(el: HTMLElement, band: "needs" | "all"): Array<[string, boolean]> {
  return Array.from(el.querySelectorAll(`[data-band="${band}"] [data-feature-name]`)).map((n) => [
    (n as HTMLElement).dataset.featureName!,
    n.classList.contains("border")
  ]);
}

/** Each band header as a [label, count] pair, in DOM order. Pairs, never a bare
 *  number: two headers each show a count, and "some header says 5" is satisfied
 *  by the wrong one saying it.
 *
 *  Keyed on `data-band-head`, not on a styling class. These used to be found by
 *  `.label-micro`, which broke the moment the band headers stopped being
 *  12px uppercase — a test that keys on how something looks fails when only the
 *  look changes, and says nothing when the structure does. */
function bandCounts(el: HTMLElement): Array<[string | null, string | null]> {
  return Array.from(el.querySelectorAll("[data-band-head]")).map((n) => [
    n.children[0]?.textContent ?? null,
    n.children[1]?.textContent ?? null
  ]);
}

/** The project group headings band 2 renders, in DOM order. */
function groupHeadings(el: HTMLElement): (string | undefined)[] {
  return Array.from(el.querySelectorAll('[data-band="all"] [data-project-group]')).map(
    (n) => (n as HTMLElement).dataset.projectGroup
  );
}

/** The hrefs one band's rows link to, in DOM order. */
function bandHrefs(el: HTMLElement, band: "needs" | "all"): (string | null)[] {
  return Array.from(el.querySelectorAll(`[data-band="${band}"] a`)).map((a) =>
    a.getAttribute("href")
  );
}

function seed(projects: unknown[], items: WorkItemDto[]) {
  useProjectsStore.setState({ projects: projects as never });
  useWorkItemsStore.setState({ items: new Map(items.map((i) => [i.id, i])) as never });
}

test("the needs-you band lists flagged features, urgent first", () => {
  seed(
    [proj("p1", "frp", "md-frp", [["f1", "alpha"], ["f2", "beta"], ["f3", "gamma"]])],
    [wi("f1", "review"), wi("f2", null), wi("f3", "input")]
  );
  const el = render("/activity");
  expect(bandRows(el, "needs")).toEqual(["gamma", "alpha"]);
});

test("the whole needs-you band, header included, is absent when nothing is flagged", () => {
  seed([proj("p1", "frp", "md-frp", [["f1", "alpha"]])], [wi("f1", null)]);
  const el = render("/activity");
  // Assert the HEADER is gone, not merely that there are no rows — an
  // empty-but-rendered band would pass a row-count assertion.
  expect(el.textContent).not.toContain("Needs you");
  expect(el.querySelector('[data-band="needs"]')).toBe(null);
  expect(el.textContent).toContain("All features");
  // Exactly one header, and it is the surviving band's — structural, so a
  // "Needs you 0" header rendered with no band under it fails here as well as
  // on the text assertion above.
  expect(bandCounts(el)).toEqual([["All features", "1"]]);
});

test("a flagged feature appears in both bands", () => {
  seed([proj("p1", "frp", "md-frp", [["f1", "alpha"]])], [wi("f1", "input")]);
  const el = render("/activity");
  expect(bandRows(el, "needs")).toEqual(["alpha"]);
  expect(bandRows(el, "all")).toEqual(["alpha"]);
  // The needs-band row's name is only evidence paired with where it goes: a
  // band-1 row must route by the selection's own href, not by anything the
  // component recomputes from the name.
  expect(bandHrefs(el, "needs")).toEqual(["/projects/md-frp/features/w-alpha"]);
});

/** The fixture the band-1 row tests share: two live features named `main`, one
 *  in each project. That is a shape production permits —
 *  `idx_features_active_name` is unique on `(project_id, name)` among
 *  unarchived rows, so the name is unique only inside a project — and band 1 is
 *  the band with no group heading to fall back on.
 *
 *  Fed mandate-first with mandate's row the LESS urgent of the two, so neither
 *  expected order below is the feed order surviving a no-op sort. The urgencies
 *  differ so the two rows are not interchangeable in any of the three
 *  dimensions asserted: order, project, urgency. */
function sameNameFixture() {
  seed(
    [
      proj("p1", "mandate", "md-mandate", [["f1", "main"]]),
      proj("p2", "frp", "md-frp", [["f2", "main"]])
    ],
    [wi("f1", "review"), wi("f2", "input")]
  );
}

test("each needs-you row names the project it sits under", () => {
  sameNameFixture();
  const el = render("/activity");
  // Name and project as ONE unit. Both rows are named `main`, so a bare name
  // list cannot tell them apart at all, and a band-1 row that dropped its
  // project label would leave the user two identical rows to choose between.
  expect(bandNameAndProject(el, "needs")).toEqual([
    ["main", "frp"],
    ["main", "mandate"]
  ]);
  // The routing half of the same claim — which of the two `main` features each
  // row actually opens. Transposing the pair changes this list too.
  expect(bandHrefs(el, "needs")).toEqual([
    "/projects/md-frp/features/w-main",
    "/projects/md-mandate/features/w-main"
  ]);
  // Band 2 names the project once, as a heading, so its rows carry no label.
  // That is what makes the labels above evidence: they come from a prop band 1
  // passes and band 2 does not, rather than from something every row renders.
  expect(bandNameAndProject(el, "all")).toEqual([
    ["main", null],
    ["main", null]
  ]);
});

test("each needs-you row states its own urgency", () => {
  sameNameFixture();
  const el = render("/activity");
  // The two rows differ in urgency, so a constant dot — or one wired to
  // anything other than the row's own flag — collapses both to one value and
  // this list changes. The dot is the only place urgency is stated at all.
  expect(bandUrgency(el, "needs")).toEqual([
    ["main", "urgency: input"],
    ["main", "urgency: review"]
  ]);
});

test("the frame is on the needs-you rows and only there", () => {
  sameNameFixture();
  const el = render("/activity");
  expect(bandFramed(el, "needs")).toEqual([
    ["main", true],
    ["main", true]
  ]);
  // The same two features, unframed, in band 2. The pairing is what makes the
  // `true`s above unreachable without the flag band 1 passes: a frame drawn on
  // every row would satisfy the first list and fail this one.
  expect(bandFramed(el, "all")).toEqual([
    ["main", false],
    ["main", false]
  ]);
});

test("clicking a needs-you row fires onNavigate", () => {
  // Band 1 is the dispatcher: on a phone the motion is hamburger, scan "Needs
  // you", tap. MobileNav passes the drawer's close callback in, so a band-1 row
  // wired without it navigates and leaves the drawer sitting over the page it
  // just opened. The band-2 click test below is a different prop on a different
  // element and covers none of this.
  seed([proj("p1", "frp", "md-frp", [["f1", "alpha"]])], [wi("f1", "input")]);
  let closed = 0;
  const el = render("/activity", { onNavigate: () => { closed += 1; } });
  const row = el.querySelector('[data-band="needs"] [data-feature-name="alpha"]');
  // querySelector returns null, never undefined, so this has to test against
  // null — and as a boolean, so a failure does not serialise a DOM node.
  expect(row === null).toBe(false);
  act(() => {
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  // Once, not merely truthy: the same feature is also a row in band 2, and a
  // handler that fired twice would be a drawer closed over a closed drawer.
  expect(closed).toBe(1);
});

test("each band header counts the rows beneath it", () => {
  // The counts have to vary in every dimension a wrong wiring could match, so
  // the fixture makes all five numbers distinct: 3 flagged, 5 features, 2
  // projects, 4 work items, and neither count is zero. A header wired to the
  // project count, to the work-item count, or to the other band's count is a
  // different number in the list below.
  seed(
    [
      proj("p1", "mandate", "md-mandate", [["f1", "alpha"], ["f2", "beta"], ["f3", "gamma"]]),
      proj("p2", "frp", "md-frp", [["f4", "delta"], ["f5", "epsilon"]])
    ],
    [wi("f1", "input"), wi("f2", null), wi("f4", "review"), wi("f5", "input")]
  );
  const el = render("/activity");
  // The rows first, so "the count" below means the number of rows under that
  // header rather than a number that merely holds still across a refactor.
  expect(bandRows(el, "needs")).toEqual(["alpha", "epsilon", "delta"]);
  expect(bandRows(el, "all")).toEqual(["alpha", "beta", "gamma", "delta", "epsilon"]);
  expect(bandCounts(el)).toEqual([
    ["Needs you", "3"],
    ["All features", "5"]
  ]);
});

test("all-features keeps the store's order, and the open feature does not move it", () => {
  // The store's order is the user's: projects load `order by sort_order asc`
  // and the projects page drag-reorders them, persisted server-side. Nothing
  // here may reorder that. The fixture separates all three candidates:
  //   - store order is NOT alphabetical (codex < frp < mandate), so a name sort
  //     would emit [codex, frp, mandate];
  //   - the open feature belongs to frp, which is fed SECOND, so the earlier
  //     float-the-current-project rule would emit [frp, mandate, codex].
  // Rendering at a feature route rather than a neutral one is the whole point:
  // it is what proves the list does not rearrange under a click. Floating was
  // removed because it moved the row you had just chosen, and every group with
  // it — this list is scanned, so a fixed position is worth more than proximity.
  seed(
    [
      proj("p1", "mandate", "md-mandate", [["f1", "alpha"]]),
      proj("p2", "frp", "md-frp", [["f2", "beta"]]),
      proj("p3", "codex", "md-codex", [["f3", "gamma"]])
    ],
    []
  );
  const el = render("/projects/md-frp/features/w-beta");
  expect(groupHeadings(el)).toEqual(["mandate", "frp", "codex"]);
});

test("a project whose features are all archived contributes no heading", () => {
  // An empty project would otherwise render a heading and its rule line over
  // nothing. Fed first, so dropping it is a filter and not an off-by-one.
  seed(
    [
      proj("p1", "frp", "md-frp", []),
      proj("p2", "mandate", "md-mandate", [["f1", "alpha"]])
    ],
    []
  );
  const el = render("/activity");
  expect(groupHeadings(el)).toEqual(["mandate"]);
  expect(bandRows(el, "all")).toEqual(["alpha"]);
});

test("within a group, unpinned features are ordered by name", () => {
  // Fed in reverse name order with neither pinned, so the expected order is
  // reachable only through the name comparison: sort is stable, so a
  // comparator returning 0 for two unpinned features hands back the feed
  // order. The pinned test below cannot cover this — it only ever compares a
  // pinned row against an unpinned one.
  seed([proj("p1", "frp", "md-frp", [["f2", "zeta"], ["f1", "alpha"]])], []);
  const el = render("/activity");
  expect(bandRows(el, "all")).toEqual(["alpha", "zeta"]);
});

test("within a group, pinned features come before unpinned", () => {
  // `zeta` sorts last by name but is pinned, so it must lead — a plain name
  // sort would return alpha, zeta.
  seed(
    [proj("p1", "frp", "md-frp", [["f1", "alpha"], ["f2", "zeta", "2026-08-01T00:00:00Z"]])],
    []
  );
  const el = render("/activity");
  expect(bandRows(el, "all")).toEqual(["zeta", "alpha"]);
});

/** The fixture both active-row tests use. `beta` is deliberately neither the
 *  first row of its group nor the first group: a component that marked the
 *  head of the list would mark `alpha`, and one that marked the head of the
 *  last group would mark `gamma`. Nothing is flagged, so band 1 is absent and
 *  the only rows in the DOM are band 2's. */
function activeRowFixture() {
  seed(
    [
      // Features fed in reverse name order, so the expected [alpha, beta]
      // below is produced by the name comparison rather than by the feed
      // order surviving a stable sort.
      proj("p1", "frp", "md-frp", [["f2", "beta"], ["f1", "alpha"]]),
      proj("p2", "mandate", "md-mandate", [["f3", "gamma"]])
    ],
    []
  );
}

test("the row of the open feature is the current one, and it alone", () => {
  activeRowFixture();
  const el = render("/projects/md-frp/features/w-beta");
  expect(bandCurrent(el, "all")).toEqual([
    ["alpha", null],
    ["beta", "page"],
    ["gamma", null]
  ]);
  // aria-current is only half of it. The row's styling hangs off `[&.active]:`,
  // which fires on a class the router appends — assert the class lands on the
  // same row, or a later hand-rolled aria-current would satisfy the pair above
  // while the highlight silently stayed dead.
  const active = Array.from(el.querySelectorAll("[data-feature-name].active")).map(
    (n) => (n as HTMLElement).dataset.featureName
  );
  expect(active).toEqual(["beta"]);
});

test("the row stays current on the feature's pane sub-route", () => {
  // /projects/:projectSlug/features/:featureSlug/pane/:paneId is a real route
  // (App.tsx). The tree this replaces spelled the span out as
  // `pathname === url || pathname.startsWith(url + "/")`; prefix matching is
  // what reproduces it, and passing `end` would break exactly this case while
  // leaving the exact-route test above green.
  activeRowFixture();
  const el = render("/projects/md-frp/features/w-beta/pane/pane-1");
  expect(bandCurrent(el, "all")).toEqual([
    ["alpha", null],
    ["beta", "page"],
    ["gamma", null]
  ]);
});

test("each row links to the tmux-named feature route under its own project", () => {
  // Store order is mandate-then-frp, against the alphabet, so the expected
  // list is not one a name sort could produce either.
  seed(
    [
      proj("p1", "mandate", "md-mandate", [["f2", "main"]]),
      proj("p2", "frp", "md-frp", [["f1", "main"]])
    ],
    []
  );
  const el = render("/activity");
  const hrefs = bandHrefs(el, "all");
  // Two features named `main`: the pair (name, href) is the unit under test.
  expect(hrefs).toEqual([
    "/projects/md-mandate/features/w-main",
    "/projects/md-frp/features/w-main"
  ]);
});

test("clicking an all-features row fires onNavigate", () => {
  // The component's whole public interface. Task 3 passes the mobile drawer's
  // close callback here; a dead onClick means tapping a feature navigates and
  // leaves the drawer sitting over the page it navigated to. Band 1 passes the
  // same prop from a separate call site and is covered separately above.
  seed([proj("p1", "frp", "md-frp", [["f1", "alpha"]])], []);
  let closed = 0;
  const el = render("/activity", { onNavigate: () => { closed += 1; } });
  const row = el.querySelector('[data-band="all"] [data-feature-name="alpha"]');
  // querySelector returns null, never undefined, so this has to test against
  // null — and as a boolean, so a failure does not serialise a DOM node.
  expect(row === null).toBe(false);
  act(() => {
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  // Once, not merely truthy: a handler wired twice would close a drawer that
  // is already closed, and the count is what distinguishes that.
  expect(closed).toBe(1);
});

test("each row states its urgency in something other than colour", () => {
  // Three rows, three different states — so a map keyed by the work item's own
  // id instead of its featureId, or a hardcoded dot, collapses all three to
  // `idle` and the expected list changes. gamma has no work item at all, which
  // is the third state rather than a missing one.
  seed(
    [proj("p1", "frp", "md-frp", [["f1", "alpha"], ["f2", "beta"], ["f3", "gamma"]])],
    [wi("f1", "input"), wi("f2", "review")]
  );
  const el = render("/activity");
  expect(bandUrgency(el, "all")).toEqual([
    ["alpha", "urgency: input"],
    ["beta", "urgency: review"],
    ["gamma", "urgency: idle"]
  ]);
});

test("each band carries its own accessible name", () => {
  // The headers are aria-hidden, so the name has to live on the band itself —
  // and it matters precisely because a flagged feature appears in BOTH bands:
  // without it the same row is announced twice from two anonymous lists.
  seed([proj("p1", "frp", "md-frp", [["f1", "alpha"]])], [wi("f1", "input")]);
  const el = render("/activity");
  const bands = Array.from(el.querySelectorAll("[data-band]")).map((n) => [
    (n as HTMLElement).dataset.band,
    n.getAttribute("role"),
    n.getAttribute("aria-label")
  ]);
  expect(bands).toEqual([
    ["needs", "group", "Needs you"],
    ["all", "group", "All features"]
  ]);
});
