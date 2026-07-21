import { expect, test, beforeEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TopFeatureCard } from "../src/client/routes/projects/TopFeatureCard";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";

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
        <TopFeatureCard
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
});

test("body preview strips basic markdown markers (##, **, backticks) for readability", () => {
  const fullBody = "## Plan\n- step one with `code`\n- **bold** marker";
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <TopFeatureCard
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
        <TopFeatureCard
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
});

test("a summary that adds to phaseDetail still shows its extra content", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <TopFeatureCard
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
        <TopFeatureCard
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
        <TopFeatureCard
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
        <TopFeatureCard
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

test("does not render ack action when work item no longer needs user", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <TopFeatureCard
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
        <TopFeatureCard
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={() => { n++; }}
        />
      </MemoryRouter>
    );
  });
  const btns = Array.from(container.getElementsByTagName("button"));
  const chatBtn = btns.find((b) => (b.textContent ?? "").toLowerCase().includes("chat"));
  expect(chatBtn).toBeDefined();
  act(() => { chatBtn!.click(); });
  expect(n).toBe(1);
});

test("renders canvas marker when canvasId is non-null", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <TopFeatureCard
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
        <TopFeatureCard
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
        <TopFeatureCard
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
