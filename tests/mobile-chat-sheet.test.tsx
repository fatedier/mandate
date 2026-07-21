import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { MobileChatSheet } from "../src/client/routes/window/chat/MobileChatSheet.js";
import { newThreadState, useAgentChatStore } from "../src/client/store/agent-chat.js";
import { useProjectsStore, type Project } from "../src/client/store/projects.js";
import { fakePhoneWidth } from "./fake-phone-width.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Installs a fake visualViewport so the keyboard-open branch can run. The
 *  real hook reads `window.visualViewport` once on mount, so this has to be in
 *  place before render. Returns a restore fn. */
function fakeViewport(innerHeight: number, visualHeight: number, offsetTop = 0) {
  const win = globalThis.window as unknown as Record<string, unknown>;
  // Capture descriptors, not values. Restoring `innerHeight` with a fabricated
  // { value } descriptor would permanently convert it from an accessor into a
  // static data property for the rest of the test process, and the damage
  // would surface in some unrelated file as a frozen window height.
  const previousInner = Object.getOwnPropertyDescriptor(win, "innerHeight");
  const previousViewport = Object.getOwnPropertyDescriptor(win, "visualViewport");
  const events = new EventTarget();
  Object.defineProperty(win, "innerHeight", { value: innerHeight, configurable: true });
  Object.defineProperty(win, "visualViewport", {
    value: {
      height: visualHeight,
      offsetTop,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events)
    },
    configurable: true
  });
  return () => {
    if (previousInner) Object.defineProperty(win, "innerHeight", previousInner);
    else delete win.innerHeight;
    if (previousViewport) Object.defineProperty(win, "visualViewport", previousViewport);
    else delete win.visualViewport;
  };
}

/** A project carrying one feature, so the header renders a feature tab.
 *  Spelled out in full rather than partially: tests/ sits outside both
 *  typecheck gates (`tsconfig.json` includes only src/client + src/shared), so
 *  a missing required field here is caught by nothing. */
function makeProjectWithFeature(): Project {
  return {
    id: "p1",
    name: "Mandate",
    workingDir: "/tmp/mandate",
    isGit: true,
    gitRemote: null,
    tmuxSessionName: "md-mandate",
    ownership: "app",
    sortOrder: 0,
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    archivedAt: null,
    tmuxAlive: true,
    tmuxStatus: "alive",
    features: [{
      id: "f1",
      projectId: "p1",
      name: "Payments",
      mode: "shared-cwd",
      branch: null,
      baseRef: null,
      worktreePath: null,
      tmuxWindowName: "payments",
      ownership: "app",
      pinnedAt: null,
      createdAt: "2026-07-31T00:00:00Z",
      updatedAt: "2026-07-31T00:00:00Z",
      archivedAt: null,
      tmuxAlive: true,
      tmuxStatus: "alive"
    }]
  };
}

/** Presence as a boolean, never the node. `expect(node).toBeNull()` serialises
 *  the entire happy-dom element on failure — listener maps plus the whole
 *  parent chain, ~107MB — which stalls the runner instead of reporting. The
 *  selector already says which node was meant, so the node adds nothing. */
const has = (selector: string) => document.querySelector(selector) !== null;

/** Lets the handle be declared before the `try` so the mount can happen inside
 *  it. That shape is a convention, not the fixture guarantee: `mount()` acquires
 *  its process-global fixtures internally, so it owns unwinding them on a failed
 *  render (see the try/catch there). What moving the call site does buy is the
 *  *caller's* own fixtures — `fakePhoneWidth()` below is restored in a `finally`
 *  that a throwing mount would otherwise skip. */
type Mounted = ReturnType<typeof mount>;

/** The feature route for makeProjectWithFeature(). Slugs are the tmux names:
 *  a project's is `tmuxSessionName`, a feature's is `tmuxWindowName`. */
const FEATURE_PATH = "/projects/md-mandate/features/payments";

function mount(
  viewport?: {
    innerHeight: number;
    visualViewportHeight: number;
    visualViewportOffsetTop?: number;
  },
  /** Only matters to tests that need `useRouteFeature()` to resolve — it is the
   *  only source of a feature tab while the drawer sits on the overview scope,
   *  since the other source is the drawer scope itself. */
  initialPath = "/"
) {
  const restoreViewport = viewport
    ? fakeViewport(
        viewport.innerHeight,
        viewport.visualViewportHeight,
        viewport.visualViewportOffsetTop ?? 0
      )
    : () => {};

  // The sheet renders AgentChatPanel, which loads its thread on mount. The
  // shared test setup makes any real fetch throw, and that rejection would
  // otherwise surface as an unhandled error and fail whichever test happens
  // to be running next.
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response(JSON.stringify({
    thread: null,
    messages: [],
    hasMore: false,
    contextUsage: null
  }), { status: 200, headers: { "content-type": "application/json" } });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  const teardown = () => {
    try {
      act(() => root.unmount());
      host.remove();
    } finally {
      // In a `finally`, and last: these two are the ones that escape this file.
      // A throwing unmount must not be able to strand the stubbed fetch in the
      // process — that would silently disable tests/setup.ts's
      // throw-on-real-network guard for every file that runs after this one.
      globalThis.fetch = originalFetch;
      restoreViewport();
    }
  };

  // Both fixtures above are process-global and are installed *before* this
  // render. If the render throws, `mount` never returns, so the caller never
  // receives `unmount` and has nothing to undo them with — wrapping the call
  // site cannot help, because the window is in here. Tear down on the way out,
  // then let the error propagate unchanged.
  try {
    act(() => {
      root.render(
        <MemoryRouter initialEntries={[initialPath]}>
          {/* Stand-in for the page behind the sheet. Without it there is nothing
              for the modality assertion to look at, and it would end up matching
              whichever of Radix's own nodes happens to carry aria-hidden. */}
          <div data-testid="page-behind">
            <button type="button">behind</button>
          </div>
          <MobileChatSheet />
        </MemoryRouter>
      );
    });
  } catch (e) {
    teardown();
    throw e;
  }

  return { host, unmount: teardown };
}

function openSheet() {
  act(() => {
    useAgentChatStore.setState({
      drawerOpen: true,
      drawerScope: { type: "manager" },
      drawerMode: "side"
    });
  });
}

beforeEach(() => {
  act(() => { useAgentChatStore.setState({ drawerOpen: false, drawerScope: null, drawerMode: "side" }); });
  document.body.innerHTML = "";
});

// Clean up on the way out, not just on the way in: bun runs every test file in
// one process, so everything these fixtures set — an open drawer, a feature
// scope, a side conversation, the loaded threads, the projects — is what the
// NEXT file starts with. This is the exact leak this file was on the receiving
// end of; see the afterEach in agent-chat-panel-route-sync. It has to name
// every field the fixtures touch, not just the last one that bit someone.
// The beforeEach above deliberately stays narrow: guarding against other
// files' leaks belongs in those files.
afterEach(() => {
  act(() => {
    useAgentChatStore.setState({
      drawerOpen: false,
      drawerScope: null,
      drawerMode: "side",
      threadsByScope: new Map(),
      sideActive: false,
      sideThread: null,
      sideParentScope: null
    });
  });
  useProjectsStore.setState({ projects: [], byId: {}, bySlug: {} });
});

test("the mobile sheet fills the viewport even when drawerMode is side", () => {
  let view: Mounted | null = null;
  try {
    view = mount();
    openSheet();
    // drawerMode is deliberately left at "side" — the mobile sheet must ignore it.
    // On a phone nothing can ever set it to "fullscreen": the only control that
    // does is `hidden md:inline-flex`.
    const content = document.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();

    // Assert the geometry, not a height class: the sheet is `position: fixed`
    // and sets `height` inline, so any `h-*` class it carries is decoration
    // that the inline value overrides.
    //
    // With the keyboard down the sheet is TOP-anchored and one viewport tall —
    // it is `top` + `height` that place it, and a `bottom` would be ignored
    // (CSS drops `bottom` when all three are set). The partial sheet it
    // replaced set no `top` at all and floated on a safe-area-lifted `bottom`,
    // so `top` is the load-bearing difference. Do not read this as "anchored at
    // both edges" — CSS does not do that, and the keyboard-open branch below
    // deliberately anchors from the bottom instead.
    const style = (content as unknown as HTMLElement).style;
    expect(style.top).toBe("0px");

    const cls = content!.className;
    expect(cls).not.toContain("78svh");
    expect(cls).not.toContain("rounded-xl");
    // Nothing inline sets these three, so the classes really are the behavior.
    expect(cls).toContain("rounded-none");
    expect(cls).toContain("border-t-0");
    // The sheet covers TopBar, which was the only thing paying the top inset.
    expect(cls).toContain("pt-[env(safe-area-inset-top)]");
  } finally {
    view?.unmount();
  }
});

test("the mobile sheet spans the visible viewport when the keyboard is up", () => {
  // The keyboard-closed height is `100dvh`, which happy-dom's CSS parser drops
  // (it rejects dvh/svh on `height`), so that branch cannot be read back here.
  // The keyboard-open branch resolves to a plain px value, which survives — so
  // this is where the height is actually assertable.
  let view: Mounted | null = null;
  try {
    view = mount({ innerHeight: 800, visualViewportHeight: 500 });
    openSheet();
    const content = document.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    const style = (content as unknown as HTMLElement).style;
    // Bottom-anchored, and exactly as tall as the area the keyboard leaves
    // visible. keyboardOffset = 800 - 500 - 0.
    expect(style.top).toBe("");
    expect(style.bottom).toBe("300px");
    expect(style.height).toBe("500px");
  } finally {
    view?.unmount();
  }
});

test("the mobile sheet follows a visual viewport that is offset from the top", () => {
  // iOS Safari commonly scrolls the visual viewport down when the keyboard
  // opens, leaving vv.offsetTop > 0. The sheet must sit over the *visual*
  // viewport, not the layout viewport, and the only thing that achieves this
  // is solving the top edge from `bottom` + `height` — setting `top` would
  // over-constrain the box, CSS would drop `bottom`, and the sheet would be
  // displaced upward by exactly offsetTop.
  const innerHeight = 800;
  const visualHeight = 500;
  const offsetTop = 60;
  let view: Mounted | null = null;
  try {
    view = mount({
      innerHeight,
      visualViewportHeight: visualHeight,
      visualViewportOffsetTop: offsetTop
    });
    openSheet();
    const content = document.querySelector('[role="dialog"]');
    expect(content).not.toBeNull();
    const style = (content as unknown as HTMLElement).style;

    // No `top`: it must be solved, not declared.
    expect(style.top).toBe("");
    // keyboardOffset = 800 - 500 - 60 = 240.
    expect(style.bottom).toBe("240px");
    expect(style.height).toBe("500px");

    // The resolved top edge is what actually matters. CSS solves it as
    // innerHeight - bottom - height, which must land on the visual viewport.
    const resolvedTop =
      innerHeight - Number.parseFloat(style.bottom) - Number.parseFloat(style.height);
    expect(resolvedTop).toBe(offsetTop);
  } finally {
    view?.unmount();
  }
});

test("the mobile sheet is modal, so the page behind is taken out of the tree", () => {
  let view: Mounted | null = null;
  try {
    view = mount();
    // This is the half that cannot be skipped: fullscreen hides the page
    // behind visually, so leaving it in the accessibility tree would let Tab
    // and a screen reader walk into content nobody can see.
    const behind = document.querySelector('[data-testid="page-behind"]');
    expect(behind).not.toBeNull();
    // Spelled out rather than via has(): the question is about an ancestor of a
    // node, which closest() answers and querySelector cannot. Same rule though —
    // compare to null here, never hand the node itself to expect().
    expect(behind!.closest('[aria-hidden="true"]') !== null).toBe(false);

    openSheet();

    // closest() rather than an attribute check on `behind` itself: Radix hides
    // the outermost node it is allowed to hide, which is some ancestor of the
    // page behind, not necessarily the page-behind node. What matters is that
    // the page behind ends up inside an aria-hidden subtree — assert that, not
    // the level it lands on.
    expect(behind!.closest('[aria-hidden="true"]')).not.toBeNull();
  } finally {
    view?.unmount();
  }
});

test("the mobile sheet renders the dim overlay again", () => {
  let view: Mounted | null = null;
  try {
    view = mount();
    // `noOverlay` existed only to keep the page behind visible, and it was the
    // sheet's last caller. Assert the overlay node is really there — the prop
    // itself was never forwarded to the DOM, so checking for its absence as an
    // attribute would pass no matter what the code did.
    expect(has('[data-slot="sheet-overlay"]')).toBe(false);

    openSheet();

    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
  } finally {
    view?.unmount();
  }
});

test("the drag handle markup is gone for good", () => {
  let view: Mounted | null = null;
  try {
    view = mount();
    openSheet();
    // `showDragHandle` defaulted to false and neither call site ever passed
    // true, so this markup never rendered anywhere. The test exists to stop
    // someone reintroducing it under the impression that mobile has a drag
    // affordance — it does not.
    expect(has('[aria-hidden="true"] > .h-1.w-10')).toBe(false);
  } finally {
    view?.unmount();
  }
});

test("the context pill shows on mobile when there is no feature tab", () => {
  const restoreWidth = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = mount();
    openSheet();
    // Measured at 390px: the header's content box is 358px, tabs take 79px and
    // the buttons 112px, leaving 159px unused. The pill needs 44px, so showing
    // it truncates nothing. The desktop container query stays as it is.
    const pill = document.querySelector('[aria-label^="Last successful"], [aria-label^="No successful"]');
    expect(pill).not.toBeNull();
    // Two assertions, and the second is the one that means "visible". Dropping
    // `@[27rem]` only proves WHICH BRANCH was taken — a compact branch of
    // `"hidden"` satisfies it perfectly while showing the user nothing, which
    // is the original bug wearing a green test. `not.toContain("hidden")` is
    // what pins that the branch chosen actually puts the pill on screen.
    expect(pill!.className).not.toContain("@[27rem]");
    expect(pill!.className).not.toContain("hidden");
  } finally {
    view?.unmount();
    restoreWidth();
  }
});

test("the mobile scope control replaces both tabs and lets the pill in", () => {
  // Measured at 390px: two tabs took 232.11px of a 358px content box, leaving
  // 5.89px — the pill needs 43.31px, so no arrangement of the old parts fit.
  // One control replaces them, so the row keeps enough spare for the pill.
  // The width figures below were measured against the swap control this
  // replaced; the picker is the same single trigger, so the argument carries
  // but the exact numbers are no longer re-measured.
  const restoreWidth = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = mount();
    act(() => {
      useProjectsStore.getState().addProject(makeProjectWithFeature());
      useAgentChatStore.setState({
        drawerOpen: true,
        drawerScope: { type: "worker", featureId: "f1" },
        drawerMode: "side"
      });
    });

    // Guard the fixture first: if the feature never resolved, everything below
    // would pass for the wrong reason.
    const control = document.querySelector('[aria-label^="Chatting with"]');
    expect(control).not.toBeNull();
    expect(control!.textContent).toContain("Payments");

    // Count scope toggles, excluding the desktop pane zoom control.
    expect(document.querySelectorAll("[aria-pressed]:not([data-pane-zoom])").length).toBe(0);

    // Container queries do not evaluate in happy-dom, so the class is the only
    // observable — `hidden @[27rem]:flex` on a 358px header means hidden. Both
    // halves are asserted: the first says the mobile branch was taken, the
    // second that the branch renders rather than hides. See the no-feature-tab
    // test above for why the first alone proves nothing.
    const pill = document.querySelector('[aria-label^="Last successful"], [aria-label^="No successful"]');
    expect(pill).not.toBeNull();
    expect(pill!.className).not.toContain("@[27rem]");
    expect(pill!.className).not.toContain("hidden");
  } finally {
    view?.unmount();
    restoreWidth();
  }
});

/** Radix opens a dropdown on `pointerdown`, not `click`, so a plain `.click()`
 *  leaves the menu shut and every row lookup below it returns null. */
function openMenu(trigger: HTMLElement): void {
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
}

/** A picker row by its visible name. The menu portals out of the mount root,
 *  so this queries the document. */
function itemLabelled(name: string): HTMLElement | null {
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
  return items.find((el) => el.textContent?.includes(name)) ?? null;
}

test("the mobile scope picker switches in both directions", () => {
  // Two taps now, not one: open the list, choose a scope. That is the cost of
  // making the control behave the same on every route — the swap it replaced
  // was one tap but only worked where a counterpart existed.
  const restoreWidth = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = mount(undefined, FEATURE_PATH);
    act(() => {
      useProjectsStore.getState().addProject(makeProjectWithFeature());
      useAgentChatStore.setState({
        drawerOpen: true,
        drawerScope: { type: "worker", featureId: "f1" },
        drawerMode: "side"
      });
    });

    // On the feature scope the trigger names the feature.
    const trigger = document.querySelector('[aria-label^="Chatting with"]') as HTMLElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Payments");

    // Feature -> Manager.
    act(() => { openMenu(trigger!); });
    const toManager = itemLabelled("Manager");
    expect(toManager).not.toBeNull();
    act(() => { toManager!.click(); });
    expect(useAgentChatStore.getState().drawerScope).toEqual({ type: "manager" });

    // And back. The trigger now names Manager, and the list still offers the
    // feature — the fixture that would fail if the picker only listed what the
    // route knows about, which is exactly what the swap could do.
    const trigger2 = document.querySelector('[aria-label^="Chatting with"]') as HTMLElement | null;
    expect(trigger2!.textContent).toContain("Manager");
    act(() => { openMenu(trigger2!); });
    const toFeature = itemLabelled("Payments");
    expect(toFeature).not.toBeNull();
    act(() => { toFeature!.click(); });
    expect(useAgentChatStore.getState().drawerScope).toEqual({ type: "worker", featureId: "f1" });
  } finally {
    view?.unmount();
    restoreWidth();
  }
});

test("the picker badges unread elsewhere, and never the scope you are on", () => {
  // The swap control badged the one other scope, which only worked because
  // there were exactly two. A list has no single "other", so the trigger
  // carries the total from everywhere else and the rows carry the breakdown.
  // Both scopes are seeded on purpose: with only one set, a badge reporting the
  // wrong scope would render nothing and still look correct.
  const restoreWidth = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = mount();
    act(() => {
      useProjectsStore.getState().addProject(makeProjectWithFeature());
      useAgentChatStore.setState({
        drawerOpen: true,
        drawerScope: { type: "worker", featureId: "f1" },
        drawerMode: "side",
        threadsByScope: new Map([
          ["manager", { ...newThreadState(), unreadAssistantCount: 3 }],
          ["worker:f1", { ...newThreadState(), unreadAssistantCount: 7 }]
        ])
      });
    });

    // Sitting on the feature, the trigger reports Manager's 3 — and not the
    // feature's own 7, nor the 10 it would show if it summed everything.
    const trigger = document.querySelector('[aria-label^="Chatting with"]') as HTMLElement | null;
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("3");
    expect(trigger!.textContent).not.toContain("7");
    expect(trigger!.getAttribute("aria-label")).toContain("3 unread elsewhere");

    // In the list, Manager carries its 3 and the row you are on carries
    // nothing — a count beside "you are here" is noise.
    act(() => { openMenu(trigger!); });
    expect(itemLabelled("Manager")!.textContent).toContain("3");
    expect(itemLabelled("Payments")!.textContent).not.toContain("7");
  } finally {
    view?.unmount();
    restoreWidth();
  }
});

test("mobile with no counterpart offers a picker, not a dead Manager tab", () => {
  // Off a feature route with the drawer on overview there is nothing to swap
  // to, so `ScopeSwitchButton` cannot render. This used to fall through to the
  // desktop tab branch and show a lone "Manager" — which is how a phone on
  // /projects ended up unable to reach any feature's own thread without first
  // navigating to that feature. The picker is what replaced it.
  const restoreWidth = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = mount();
    act(() => {
      useProjectsStore.getState().addProject(makeProjectWithFeature());
      useAgentChatStore.setState({
        drawerOpen: true,
        drawerScope: { type: "manager" },
        drawerMode: "side"
      });
    });

    // The swap control is absent because it has no destination...
    expect(has('[aria-label^="Switch to"]')).toBe(false);
    // ...and the picker is present in its place, naming where you are.
    const trigger = document.querySelector('[aria-label^="Chatting with"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("Manager");
  } finally {
    view?.unmount();
    restoreWidth();
  }
});

test("the picker is the mobile control on every route, counterpart or not", () => {
  // The first pass kept the old one-tap swap wherever a counterpart existed and
  // fell back to the picker where none did. That reads fine as a rule and works
  // badly as a control: you had to know which page you were on to know what a
  // tap would do. This pins that the route no longer changes the answer.
  const restoreWidth = fakePhoneWidth();
  for (const path of [undefined, FEATURE_PATH]) {
    let view: Mounted | null = null;
    try {
      view = mount(undefined, path);
      act(() => {
        useProjectsStore.getState().addProject(makeProjectWithFeature());
        useAgentChatStore.setState({
          drawerOpen: true,
          drawerScope: { type: "manager" },
          drawerMode: "side"
        });
      });
      expect(has('[aria-label^="Chatting with"]')).toBe(true);
      // The swap control is gone for good, not merely unrendered here.
      expect(has('[aria-label^="Switch to"]')).toBe(false);
    } finally {
      view?.unmount();
    }
  }
  restoreWidth();
});

test("desktop still renders both scope tabs and no switch control", () => {
  // The branch's most important constraint. happy-dom is 1024px, so omitting
  // fakePhoneWidth() is what puts this on the desktop path.
  let view: Mounted | null = null;
  try {
    view = mount();
    act(() => {
      useProjectsStore.getState().addProject(makeProjectWithFeature());
      useAgentChatStore.setState({
        drawerOpen: true,
        drawerScope: { type: "worker", featureId: "f1" },
        drawerMode: "side"
      });
    });

    expect(has('[aria-label^="Switch to"]')).toBe(false);
    expect(document.querySelectorAll("[aria-pressed]:not([data-pane-zoom])").length).toBe(2);
    // Desktop keeps degrading by container query, untouched. Both halves of
    // `hidden @[27rem]:flex` are pinned: hidden by default, revealed only once
    // the dock is wide enough. The mobile tests assert the exact negation of
    // this pair, so nothing can satisfy both surfaces by accident.
    const pill = document.querySelector('[aria-label^="Last successful"], [aria-label^="No successful"]');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain("@[27rem]");
    expect(pill!.className).toContain("hidden");
  } finally {
    view?.unmount();
  }
});

test("the context pill shows on mobile in a side conversation started from a feature", () => {
  // `featureTab` is derived from the route and the drawer scope, so it stays
  // truthy here — but the Side branch replaces the scope tabs entirely, so
  // there is no tab left for the pill to crowd. A rule of `!featureTab` alone
  // hides the pill on a path a phone can reach ("Start side conversation" has
  // no md: gate), which is the user's original complaint still alive.
  const restoreWidth = fakePhoneWidth();
  let view: Mounted | null = null;
  try {
    view = mount();
    act(() => {
      useProjectsStore.getState().addProject(makeProjectWithFeature());
      useAgentChatStore.setState({
        drawerOpen: true,
        drawerScope: { type: "worker", featureId: "f1" },
        drawerMode: "side",
        sideParentScope: { type: "worker", featureId: "f1" },
        sideActive: true,
        sideThread: {
          ...newThreadState(),
          threadId: "side-thread",
          contextUsage: {
            inputTokens: 32_558,
            budgetTokens: 200_000,
            updatedAt: "2026-07-31T00:00:00Z",
            source: "compression_budget"
          }
        }
      });
    });

    // Guard the fixture: this must be the Side branch (no scope tabs at all),
    // otherwise the test is silently just the no-feature-tab case again.
    expect(document.querySelector('[aria-label="Return to main conversation"]')).not.toBeNull();
    expect(has("[aria-pressed]:not([data-pane-zoom])")).toBe(false);

    const pill = document.querySelector('[aria-label^="Last successful"], [aria-label^="No successful"]');
    expect(pill).not.toBeNull();
    expect(pill!.className).not.toContain("@[27rem]");
    // Not implied by the 16% below: text lives in the DOM whether or not the
    // element is displayed, so `hidden` would satisfy that assertion too.
    expect(pill!.className).not.toContain("hidden");
    // `thread` is `sideActive ? sideThread : mainThread`, so the number on
    // screen is the side conversation's own: 32558 / 200000 = 16%.
    expect(pill!.textContent).toContain("16%");
  } finally {
    view?.unmount();
    restoreWidth();
  }
});
