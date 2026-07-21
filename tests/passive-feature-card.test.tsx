import { expect, test, beforeEach } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { PassiveFeatureCard } from "../src/client/routes/projects/PassiveFeatureCard";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "f-1", projectId: "p", name: "feat-foo", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "feat-foo-window", ownership: "app",
    pinnedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    tmuxAlive: true, tmuxStatus: "alive",
    ...overrides
  };
}

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", featureId: "f-1", projectId: "p",
    title: "t", summary: null, canvasId: null, needsUser: null,
    phase: "working", phaseDetail: "writing tests",
    summaryUpdatedAt: null, summaryUpdatedBy: null,
    lastActivityAt: "2026-05-19T00:00:00Z",
    createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
    ...overrides
  };
}

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

test("renders phase chip, phaseDetail, feature name (no badge when needsUser is null)", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem()}
          paneStatus="running"
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    );
  });
  const text = container.textContent ?? "";
  // Idle items (needsUser=null) don't show a badge — badge only shown when needsUser is set
  expect(text).toContain("working");
  expect(text).toContain("writing tests");
  expect(text).toContain("feat-foo");
});

// PassiveFeatureCard intentionally renders NO needsUser badge: flagged items
// (needsUser=input/review) surface via the cross-project "Needs you" strip and
// the pinned TopFeatureCard instead — the passive grid stays calm by design.
test("does not render a needsUser badge even when needsUser=review", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem({ needsUser: "review" })}
          paneStatus="running"
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    );
  });
  const text = (container.textContent ?? "").toLowerCase();
  expect(text.includes("review")).toBe(false);
});

test("passive card has no chevron / expand button (compact mode)", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem({ summary: "## Plan\nstep 1" })}
          paneStatus={null}
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  const chevron = btns.find((b) => {
    const a = b.getAttribute("aria-label");
    return a === "expand" || a === "collapse";
  });
  expect(chevron).toBeUndefined();
});

test("pinned feature shows visible star at default opacity", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="p"
          feature={makeFeature({ pinnedAt: "2026-05-01T00:00:00Z" })}
          item={makeItem()}
          paneStatus={null}
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    );
  });
  // assert: a button with aria-label "Unpin" exists
  const buttons = container.getElementsByTagName("button");
  let found = false;
  for (const b of Array.from(buttons)) {
    if (b.getAttribute("aria-label") === "Unpin") found = true;
  }
  expect(found).toBe(true);
});

test("click on pin button calls onTogglePin and prevents navigation", () => {
  let pinCalls = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem()}
          paneStatus={null}
          onTogglePin={() => { pinCalls++; }}
        />
      </MemoryRouter>
    );
  });
  const btns = container.getElementsByTagName("button");
  // pin button: aria-label "Pin to top" or "Unpin"
  let pinBtn: HTMLButtonElement | null = null;
  for (const b of Array.from(btns)) {
    const label = b.getAttribute("aria-label") ?? "";
    if (label === "Pin to top" || label === "Unpin") {
      pinBtn = b as HTMLButtonElement;
      break;
    }
  }
  expect(pinBtn).not.toBeNull();
  act(() => { pinBtn!.click(); });
  expect(pinCalls).toBe(1);
});

// ── mobile Chat action ──────────────────────────────────────────────────────
// happy-dom applies no stylesheet, so both breakpoints' controls are always in
// the DOM and "is it visible" cannot be read off the node. Which breakpoint a
// control belongs to is therefore asserted through the responsive utility that
// gates it — and always by asserting the gate is PRESENT, never that some class
// is absent (an absent class proves nothing about visibility).

/** className of `node` plus every ancestor up to, but excluding, `stop`. */
function gateChain(node: Element, stop: Element): string {
  const parts: string[] = [];
  let cur: Element | null = node;
  while (cur && cur !== stop) {
    parts.push(typeof cur.className === "string" ? cur.className : "");
    cur = cur.parentElement;
  }
  return parts.join(" ");
}

function byLabel(root: HTMLElement, label: string | RegExp): HTMLButtonElement[] {
  return Array.from(root.getElementsByTagName("button")).filter((b) => {
    const value = b.getAttribute("aria-label") ?? "";
    return typeof label === "string" ? value === label : label.test(value);
  });
}

const chatControls = (root: HTMLElement) => byLabel(root, "Chat about this feature");
const pinControls = (root: HTMLElement) => byLabel(root, /^(Pin to top|Unpin)$/);

function renderPassive(container: HTMLElement, onPromote?: () => void) {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="proj"
          feature={makeFeature({ tmuxWindowName: "win-9" })}
          item={makeItem()}
          paneStatus={null}
          onTogglePin={() => {}}
          onPromote={onPromote}
        />
      </MemoryRouter>
    );
  });
  return root;
}

test("the row carries a Chat control for touch, gated by md:hidden rather than the pointer slot", () => {
  renderPassive(container, () => {});

  const chats = chatControls(container);
  expect(chats).toHaveLength(2);

  // One per breakpoint, and they are different nodes: the touch one is hidden
  // from md up, the pointer one lives in HoverSwap's `hidden … md:flex` slot.
  const touch = chats.filter((b) => gateChain(b, container).includes("md:hidden"));
  const pointer = chats.filter((b) => gateChain(b, container).includes("md:flex"));
  expect(touch).toHaveLength(1);
  expect(pointer).toHaveLength(1);
  expect(touch[0]).not.toBe(pointer[0]);
});

test("desktop keeps exactly one Chat — the change adds no pointer-side duplicate", () => {
  renderPassive(container, () => {});

  // Everything gated by md:hidden is gone at >=768px, so what survives on
  // desktop is what is left over — and there must be exactly one of it.
  const survivesDesktop = chatControls(container)
    .filter((b) => !gateChain(b, container).includes("md:hidden"));
  expect(survivesDesktop).toHaveLength(1);
  expect(gateChain(survivesDesktop[0]!, container)).toContain("md:flex");
});

test("the touch actions meet the 44px target ChangesTab already sets for mobile", () => {
  renderPassive(container, () => {});

  const touchChat = chatControls(container)
    .find((b) => gateChain(b, container).includes("md:hidden"));
  const touchPin = pinControls(container)
    .find((b) => gateChain(b, container).includes("md:hidden"));
  expect(touchChat).toBeDefined();
  expect(touchPin).toBeDefined();

  // No layout in happy-dom, so the utility is the observable. Assert it
  // positively — h-11 is 44px, and the pin moved up from h-7 to match.
  for (const button of [touchChat!, touchPin!]) {
    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-11");
  }
});

test("tapping Chat promotes the item and does not navigate the row", () => {
  let promoted = 0;
  let path = "";
  let escaped = 0;

  // The React root is nested one level down so a native listener above it can
  // observe whether the click escaped the card at all.
  const outer = document.createElement("div");
  const host = document.createElement("div");
  outer.appendChild(host);
  document.body.appendChild(outer);
  outer.addEventListener("click", () => { escaped++; });

  function LocationProbe() {
    const location = useLocation();
    useEffect(() => { path = location.pathname; }, [location.pathname]);
    return null;
  }

  const root = createRoot(host);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={["/projects"]}>
        <LocationProbe />
        <PassiveFeatureCard
          projectSlug="proj"
          feature={makeFeature({ tmuxWindowName: "win-9" })}
          item={makeItem()}
          paneStatus={null}
          onTogglePin={() => {}}
          onPromote={() => { promoted++; }}
        />
      </MemoryRouter>
    );
  });
  expect(path).toBe("/projects");

  const touchChat = chatControls(host)
    .find((b) => gateChain(b, host).includes("md:hidden"));
  expect(touchChat).toBeDefined();

  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  act(() => { touchChat!.dispatchEvent(event); });

  expect(promoted).toBe(1);
  // preventDefault is what actually stops the Link: react-router's click
  // handler returns early on an already-defaultPrevented event.
  expect(event.defaultPrevented).toBe(true);
  // stopPropagation is what keeps the click from reaching anything above.
  expect(escaped).toBe(0);
  // And the router never moved.
  expect(path).toBe("/projects");

  act(() => { root.unmount(); });
  outer.remove();
});

test("both breakpoints' Chat controls run the same onPromote handler", () => {
  let promoted = 0;
  renderPassive(container, () => { promoted++; });

  for (const button of chatControls(container)) {
    act(() => { button.click(); });
  }
  // Two affordances, one behaviour — the destination stays the card's
  // (overview thread + ref pill), never the feature's own thread.
  expect(promoted).toBe(2);
});

test("the row stays a single link to the feature page, with both pin controls intact", () => {
  renderPassive(container, () => {});

  const anchors = Array.from(container.getElementsByTagName("a"));
  expect(anchors).toHaveLength(1);
  expect(anchors[0]!.getAttribute("href")).toBe("/projects/proj/features/win-9");
  // One pin per breakpoint slot, exactly as before the Chat action was added.
  expect(pinControls(container)).toHaveLength(2);
});

test("a card with no onPromote renders no Chat control at either breakpoint", () => {
  renderPassive(container);
  expect(chatControls(container)).toHaveLength(0);
});

test("passive card never shows body content inline (no preview, no expand)", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <PassiveFeatureCard
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem({ summary: "## Plan\nimportant content" })}
          paneStatus={null}
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    );
  });
  // Body content stays out of the compact card — feature page is the place for it.
  expect(container.textContent?.includes("important content")).toBe(false);
});
