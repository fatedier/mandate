import { expect, test, beforeEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { UntrackedFeatureCard } from "../src/client/routes/projects/UntrackedFeatureCard";
import type { Feature } from "../src/client/store/projects";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "f-1", projectId: "p", name: "orphan-feature", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "orphan-window", ownership: "app",
    pinnedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    tmuxAlive: true, tmuxStatus: "alive",
    ...overrides
  };
}

let container: HTMLElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

test("renders feature.name and 'untracked' label", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <UntrackedFeatureCard projectSlug="p" feature={makeFeature()} paneStatus={null} />
      </MemoryRouter>
    );
  });
  expect(container.textContent).toContain("orphan-feature");
  expect(container.textContent?.toLowerCase()).toContain("untracked");
});

test("renders pane status dot when paneStatus provided", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <UntrackedFeatureCard projectSlug="p" feature={makeFeature()} paneStatus="running" />
      </MemoryRouter>
    );
  });
  // assert some indicator of running via aria-label attribute
  const spans = container.getElementsByTagName("span");
  const dot = Array.from(spans).find((el) => el.getAttribute("aria-label") === "pane running");
  expect(dot).not.toBeUndefined();
});

// Deliberate boundary: the mobile Chat action added to PassiveFeatureCard does
// NOT extend here. The card action promotes a work-item reference into the
// overview thread, and an untracked feature is by definition one with no work
// item (feature-card-data.ts), so there is nothing to reference. Giving these
// rows a Chat entry would need a different destination, which is its own change.
test("untracked rows have no chat control at either breakpoint", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <UntrackedFeatureCard projectSlug="p" feature={makeFeature()} paneStatus={null} />
      </MemoryRouter>
    );
  });
  const chat = Array.from(container.getElementsByTagName("button"))
    .filter((b) => /chat/i.test(b.getAttribute("aria-label") ?? "") || /chat/i.test(b.textContent ?? ""));
  expect(chat).toHaveLength(0);
});

test("renders link to /projects/:slug/features/:windowName", () => {
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <UntrackedFeatureCard projectSlug="p" feature={makeFeature()} paneStatus={null} />
      </MemoryRouter>
    );
  });
  const links = container.getElementsByTagName("a");
  expect(links.length).toBeGreaterThan(0);
  const link = links[0];
  expect(link.getAttribute("href")).toContain("/projects/p/features/orphan-window");
});
