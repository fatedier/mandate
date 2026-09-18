import { expect, test, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FeatureRow } from "../src/client/routes/projects/FeatureRow.js";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";
import { fakePhoneWidth } from "./fake-phone-width";

let restoreWidth: (() => void) | null = null;
afterEach(() => { restoreWidth?.(); restoreWidth = null; });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** The innermost element whose text contains `needle`. */
function innermostWithText(root: HTMLElement, needle: string): Element | undefined {
  return Array.from(root.querySelectorAll("*")).find((el) =>
    (el.textContent ?? "").includes(needle) &&
    !Array.from(el.children).some((child) => (child.textContent ?? "").includes(needle))
  );
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "f-1", projectId: "p", name: "feat-login", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "login", ownership: "app",
    pinnedAt: null,
    createdAt: "2026-05-19T00:00:00Z",
    updatedAt: "2026-05-19T00:00:00Z",
    archivedAt: null,
    tmuxAlive: true, tmuxStatus: "alive",
    ...overrides
  };
}

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", featureId: "f-1", projectId: "p",
    title: "Auth migration", summary: "## Plan\nCompare A vs B options",
    needsUser: "input",
    phase: "working", phaseDetail: "blocked on token storage",
    summaryUpdatedAt: null, summaryUpdatedBy: null,
    lastActivityAt: "2026-05-19T00:00:00Z",
    createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
    canvasId: null,
    ...overrides
  };
}

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

function noop() {}

test("renders needsUser badge, title, phase, phaseDetail, body preview", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="running"
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const text = container.textContent ?? "";
  const textLower = text.toLowerCase();
  expect(textLower).toContain("input");
  expect(text).toContain("Auth migration");
  expect(text).toContain("working");
  expect(text).toContain("blocked on token storage");
  expect(text).toContain("Compare A vs B");      // body preview portion
  expect(container.querySelector(".pill.pill-red")?.textContent).toBe("Needs input");
});

test("body preview strips basic markdown markers (##, **, backticks) for readability", () => {
  const fullBody = "## Plan\n- step one with `code`\n- **bold** marker";
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({ summary: fullBody })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const text = container.textContent ?? "";
  // preview is cleaned: no markdown syntax visible
  expect(text.includes("##")).toBe(false);
  expect(text.includes("**")).toBe(false);
  expect(text.includes("`")).toBe(false);
  // content survives
  expect(text).toContain("Plan");
  expect(text).toContain("bold");
  // No chevron button anymore — body preview is multiline clamp
  const btns = Array.from(container.getElementsByTagName("button"));
  const chevron = btns.find((b) => {
    const a = b.getAttribute("aria-label");
    return a === "expand" || a === "collapse";
  });
  expect(chevron).toBeUndefined();
});

test("a summary that only repeats phaseDetail is not printed under the phase row", () => {
  // The phase row already prints phaseDetail; without the dedupe the card
  // shows the identical sentence twice, one line apart.
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({
            needsUser: null,
            phaseDetail: "blocked on token storage",
            summary: "- blocked on token storage"
          })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const text = container.textContent ?? "";
  const occurrences = text.split("blocked on token storage").length - 1;
  expect(occurrences).toBe(1);

  // phaseDetail is prose: sans on the element and on every ancestor (mono
  // inherits, so a mono root would make the detail mono without the detail
  // span ever carrying the class). The phase word itself stays mono.
  const detail = innermostWithText(container, "blocked on token storage");
  expect(detail).toBeDefined();
  expect(gateChain(detail!, container).split(/\s+/)).not.toContain("font-mono");
  const phaseWord = Array.from(container.querySelectorAll("span"))
    .find((el) => (el.textContent ?? "").trim() === "working");
  expect(phaseWord).toBeDefined();
  expect(phaseWord!.classList.contains("font-mono")).toBe(true);

  // Line two is 12px (§9: summary 12px). `--text-2xs` = 12px, `--text-xs` =
  // 13px, so a `text-xs` anywhere between the phase word and the row root
  // would win over the wrapper's `text-2xs` and render the line at 13px.
  const row = container.querySelector('[data-slot="feature-row"]');
  expect(row).toBeDefined();
  const lineTwoChain = gateChain(phaseWord!, row!).split(/\s+/);
  expect(lineTwoChain).not.toContain("text-xs");
  expect(lineTwoChain).toContain("text-2xs");
  // The row sits at 52px (§9): min-h-13 is the floor, py-1.5 leaves the two
  // 12/13px lines room inside it (py-2 pushed it to 59px), and justify-center
  // keeps the content centred when the floor wins.
  const rowTokens = row!.className.split(/\s+/);
  expect(rowTokens).toContain("min-h-13");
  expect(rowTokens).toContain("py-1.5");
  expect(rowTokens).toContain("justify-center");
  expect(rowTokens).not.toContain("py-2");
});

test("a summary that adds to phaseDetail still shows its extra content", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({
            needsUser: null,
            phaseDetail: "blocked on token storage",
            summary: "- blocked on token storage\n- Waiting on the security review."
          })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const text = container.textContent ?? "";
  expect(text).toContain("Waiting on the security review.");
  expect(text.split("blocked on token storage").length - 1).toBe(1);
});

test("clicking ☆ calls onTogglePin", () => {
  let pinCalls = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={() => { pinCalls++; }} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  const pinBtn = btns.find((b) => {
    const a = b.getAttribute("aria-label");
    return a === "Pin to top" || a === "Unpin";
  });
  expect(pinBtn).toBeDefined();
  act(() => { pinBtn!.click(); });
  expect(pinCalls).toBe(1);
});

test("does not render archive action on work item cards", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  const archiveBtn = btns.find((b) => (b.textContent ?? "").toLowerCase().includes("archive"));
  expect(archiveBtn).toBeUndefined();
});

test("clicking ack quick action calls onAck", () => {
  let n = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={noop} onAck={() => { n++; }} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  const ackBtn = btns.find((b) => (b.textContent ?? "").toLowerCase().includes("ack"));
  expect(ackBtn).toBeDefined();
  act(() => { ackBtn!.click(); });
  expect(n).toBe(1);
});

test("desktop: one Ack in the hover slot, slug chip on line one, no touch row", () => {
  const onAck = () => {};
  act(() => {
    createRoot(container).render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" onAck={onAck} />
      </MemoryRouter>
    );
  });
  const row = container.querySelector('[data-slot="feature-row"]')!;
  const acks = Array.from(row.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Ack");
  expect(acks.length).toBe(1);
  expect(gateChain(acks[0]!, row).split(/\s+/)).toContain("md:group-hover:opacity-100");
  // The pointer Ack is the same 22px neutral pill as the phone's, not a 28px
  // bordered button that outsized the Review pill and the bare icons beside it.
  const ackTokens = acks[0]!.className.split(/\s+/);
  for (const t of ["pill", "pill-neutral", "text-foreground"]) expect(ackTokens).toContain(t);
  for (const t of ["border", "h-7"]) expect(ackTokens).not.toContain(t);
  expect(row.querySelector('[data-slot="feature-slug"]') === null).toBe(false);
  expect(row.querySelector('[data-slot="feature-actions-touch"]') === null).toBe(true);
  expect(row.querySelector('[data-slot="feature-slug-touch"]') === null).toBe(true);
});

test("phone: a needs-you row gets one 44px action row after line one; no slug chip anywhere", () => {
  restoreWidth = fakePhoneWidth(390);
  let acked = 0;
  act(() => {
    createRoot(container).render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={makeItem({ needsUser: "review" })}
          paneStatus="idle" onAck={() => { acked += 1; }} onPromote={() => {}} onTogglePin={() => {}} />
      </MemoryRouter>
    );
  });
  const row = container.querySelector<HTMLElement>('[data-slot="feature-row"]')!;
  const touchRow = row.querySelector<HTMLElement>('[data-slot="feature-actions-touch"]')!;
  expect(touchRow === null).toBe(false);
  expect(touchRow.parentElement).toBe(row);
  // happy-dom's closest() has no `:scope`; walk up to the row's direct child.
  let lineOne: Element = row.querySelector('[data-slot="feature-title"]')!;
  while (lineOne.parentElement !== row) lineOne = lineOne.parentElement!;
  expect(touchRow.compareDocumentPosition(lineOne) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  const buttons = Array.from(touchRow.querySelectorAll("button"));
  expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toEqual(["Ack", "Chat about this feature", "Pin to top"]);
  // Visually small, still a 44px target: 22px pill Ack + 11px inset, 36px icons + 4px inset.
  const ackTokens = buttons[0]!.className.split(/\s+/);
  expect(ackTokens).toContain("pill");
  expect(ackTokens).toContain("pill-neutral");
  expect(ackTokens).toContain("before:-inset-[11px]");
  expect(ackTokens).not.toContain("border");
  for (const b of buttons.slice(1)) {
    const tokens = b.className.split(/\s+/);
    expect(tokens).toContain("h-9");
    expect(tokens).toContain("before:-inset-1");
  }
  for (const b of buttons) expect(b.className.split(/\s+/)).toContain("relative");
  act(() => { buttons[0]!.click(); });
  expect(acked).toBe(1);
  expect(row.querySelector('[data-slot="feature-slug"]') === null).toBe(true);
  expect(row.querySelector('[data-slot="feature-slug-touch"]') === null).toBe(true);
});

test("phone: Ack renders no pointer twin — the hover slot is empty of Ack", () => {
  restoreWidth = fakePhoneWidth(390);
  act(() => {
    createRoot(container).render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={makeItem({ needsUser: "review" })} paneStatus="idle" onAck={() => {}} />
      </MemoryRouter>
    );
  });
  const row = container.querySelector('[data-slot="feature-row"]')!;
  const acks = Array.from(row.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Ack");
  expect(acks.length).toBe(1);
  expect(gateChain(acks[0]!, row).split(/\s+/)).not.toContain("md:group-hover:opacity-100");
});

// The slug chip is desktop-only: measured at 390×844 it left the title 34px
// wide beside the pill and the time, and a second line for it was the old
// always-present touch row. Below md the row renders no chip at all.
function renderTopWithSlug(title: string | null = "Auth migration") {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature({ name: "feat-login", tmuxWindowName: "login" })}
          item={makeItem({ needsUser: "review", title: title ?? "", canvasId: "canvas_abc" })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
}

test("the slug is faint mono text in the right column under the time — off the title line and off the phase line", () => {
  renderTopWithSlug("Issue #5460 · waiting on review");
  const slug = container.querySelector('[data-slot="feature-slug"]')!;
  expect(slug === null).toBe(false);
  const tokens = slug.className.split(/\s+/);
  for (const t of ["font-mono", "text-faint", "truncate", "max-w-[18rem]"]) expect(tokens).toContain(t);
  for (const t of ["border", "rounded-full", "bg-sel", "pill", "min-w-0", "shrink"]) expect(tokens).not.toContain(t);
  expect(slug.textContent).toContain("login");
  // Its home is the right column (`[data-slot="feature-right"]`): a column that
  // stacks the needs pill / time line above it and never shrinks, so the slug
  // has its own width and the phase line keeps the whole second line. It is
  // the column's last child so it sits under the time, right-aligned.
  const right = container.querySelector('[data-slot="feature-right"]')!;
  expect(right === null).toBe(false);
  for (const t of ["flex", "flex-col", "items-end", "shrink-0"]) expect(right.className.split(/\s+/)).toContain(t);
  expect(right.contains(slug)).toBe(true);
  expect(right.lastElementChild === slug).toBe(true);
  expect(right.querySelector('[data-slot="feature-needs"]') === null).toBe(false);
  const phaseLine = container.querySelector('[data-slot="phase-detail"]')!.parentElement!;
  expect(phaseLine.contains(slug)).toBe(false);
  expect(container.querySelector('[data-slot="feature-title"]')!.contains(slug)).toBe(false);
});

test("neither slug slot renders when the title equals the feature name", () => {
  renderTopWithSlug("feat-login");
  expect(container.querySelector('[data-slot="feature-slug"]') === null).toBe(true);
  expect(container.querySelector('[data-slot="feature-slug-touch"]') === null).toBe(true);
});

test("does not render ack action when work item no longer needs user", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({ needsUser: null })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  const ackBtn = btns.find((b) => (b.textContent ?? "").toLowerCase().includes("ack"));
  expect(ackBtn).toBeUndefined();
});

test("clicking chat (promote) quick action calls onPromote", () => {
  let n = 0;
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={() => { n++; }}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  // Chat is an icon button on every row variant; its name is the aria-label.
  const chatBtn = btns.find((b) => b.getAttribute("aria-label") === "Chat about this feature");
  expect(chatBtn).toBeDefined();
  act(() => { chatBtn!.click(); });
  expect(n).toBe(1);
});

test("renders canvas marker when canvasId is non-null", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({ canvasId: "canvas_abc" })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const spans = Array.from(container.getElementsByTagName("span"));
  const marker = spans.find((el) => el.getAttribute("aria-label") === "Feature has canvas");
  expect(marker).toBeDefined();
  // A lucide icon, not a ▦ glyph: the character's stroke weight and baseline are
  // font-dependent, so it could never match the icons sitting beside it.
  expect(marker!.getElementsByTagName("svg").length).toBe(1);
});

test("does NOT render canvas marker when canvasId is null", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({ canvasId: null })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const spans = Array.from(container.getElementsByTagName("span"));
  const marker = spans.find((el) => el.getAttribute("aria-label") === "Feature has canvas");
  expect(marker).toBeUndefined();
});

test("card link points to the feature page when canvas badge is present", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature({ tmuxWindowName: "win" })}
          item={makeItem({ canvasId: "canvas_abc" })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  });
  const anchors = Array.from(container.getElementsByTagName("a"));
  expect(anchors).toHaveLength(1);
  expect(anchors[0]!.getAttribute("href")).toBe("/projects/p/features/win");
});
