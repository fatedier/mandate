import { expect, test, beforeEach, afterEach } from "bun:test";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { FeatureRow } from "../src/client/routes/projects/FeatureRow.js";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";
import { fakePhoneWidth } from "./fake-phone-width";

let restoreWidth: (() => void) | null = null;
afterEach(() => { restoreWidth?.(); restoreWidth = null; });

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
        <FeatureRow variant="passive"
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

// The passive row intentionally renders NO needsUser pill: flagged items
// (needsUser=input/review) surface via the sidebar's Needs-you list and the
// top-variant row instead (§3.2 forbids a cross-project strip) — the passive
// list stays calm by design.
test("does not render a needsUser badge even when needsUser=review", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="passive"
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
        <FeatureRow variant="passive"
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
        <FeatureRow variant="passive"
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
  let found: HTMLButtonElement | null = null;
  for (const b of Array.from(buttons)) {
    if (b.getAttribute("aria-label") === "Unpin") found = b;
  }
  expect(found === null).toBe(false);
  // Pinned is not a status: the filled star is the foreground colour, never
  // the review amber it shared with the "Review" pill beside it.
  const star = found!.querySelector("svg")!;
  const tokens = star.getAttribute("class")!.split(/\s+/);
  expect(tokens).toContain("fill-foreground");
  expect(tokens).toContain("text-foreground");
  expect(tokens).not.toContain("fill-status-review");
});

test("click on pin button calls onTogglePin and prevents navigation", () => {
  let pinCalls = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="passive"
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

// ── row actions per breakpoint ─────────────────────────────────────────────
// Which controls a row carries is decided by rendering on `useIsMobile()`, not
// by CSS gates, so a phone test must narrow the window BEFORE mount
// (fakePhoneWidth) and a desktop test simply mounts at happy-dom's 1024px.
// happy-dom applies no stylesheet, so the one CSS gate that remains — the
// hover slot's `md:group-hover:opacity-100` — is asserted through the utility
// that sets it, always positively (an absent class proves nothing).

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

test("desktop: exactly one Chat and one pin, both in the hover slot", () => {
  act(() => {
    createRoot(container).render(
      <MemoryRouter>
        <FeatureRow variant="passive" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" onPromote={() => {}} onTogglePin={() => {}} />
      </MemoryRouter>
    );
  });
  const row = container.querySelector('[data-slot="feature-row"]')!;
  const chats = row.querySelectorAll('[aria-label="Chat about this feature"]');
  const pins = row.querySelectorAll('[aria-label="Pin to top"]');
  expect(chats.length).toBe(1);
  expect(pins.length).toBe(1);
  expect(gateChain(chats[0]!, row).split(/\s+/)).toContain("md:group-hover:opacity-100");
  expect(row.querySelector('[data-slot="feature-actions-touch"]') === null).toBe(true);
});

test("phone: a passive row is one line — no action row, no Chat, no pin, no slug chip", () => {
  restoreWidth = fakePhoneWidth(390);
  act(() => {
    createRoot(container).render(
      <MemoryRouter>
        <FeatureRow variant="passive" projectSlug="p" feature={makeFeature()} item={makeItem({ title: "Auth migration" })} paneStatus="idle" onPromote={() => {}} onTogglePin={() => {}} />
      </MemoryRouter>
    );
  });
  const row = container.querySelector('[data-slot="feature-row"]')!;
  expect(row.querySelector('[data-slot="feature-actions-touch"]') === null).toBe(true);
  expect(row.querySelector('[data-slot="feature-slug"]') === null).toBe(true);
  // The hover slot still exists in the DOM (display:none below md) — the
  // contract is that nothing OUTSIDE it is a button.
  const outsideHover = Array.from(row.querySelectorAll("button")).filter(
    (b) => !gateChain(b, row).split(/\s+/).includes("md:group-hover:opacity-100")
  );
  expect(outsideHover.length).toBe(0);
  // Stronger than the filter above: on a phone the passive row is render-
  // branched, so the hover slot is empty and the row has no button at all.
  expect(row.querySelectorAll("button").length).toBe(0);
  expect(row.querySelector('[data-slot="feature-title"]')?.textContent).toBe("Auth migration");
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
        <FeatureRow variant="passive"
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

  const chat = chatControls(host)[0];
  expect(chat).toBeDefined();

  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  act(() => { chat!.dispatchEvent(event); });

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

test("a card with no onPromote renders no Chat control", () => {
  act(() => {
    createRoot(container).render(
      <MemoryRouter>
        <FeatureRow variant="passive" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" />
      </MemoryRouter>
    );
  });
  expect(container.querySelector('[aria-label="Chat about this feature"]') === null).toBe(true);
});

test("passive card never shows body content inline (no preview, no expand)", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="passive"
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
