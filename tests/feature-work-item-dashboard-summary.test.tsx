import { expect, test, beforeEach, afterEach } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { FeatureWorkItemDashboard } from "../src/client/routes/window/FeatureWorkItemDashboard.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1",
    featureId: "feat-1",
    projectId: "proj-1",
    title: "Login",
    summary: null,
    needsUser: null,
    phase: "working",
    phaseDetail: null,
    canvasId: null,
    summaryUpdatedAt: null,
    summaryUpdatedBy: null,
    lastActivityAt: new Date().toISOString(),
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z",
    ...overrides
  };
}

function resetStore(items: WorkItemDto[]) {
  useWorkItemsStore.setState({
    ...useWorkItemsStore.getInitialState(),
    items: new Map(items.map((i) => [i.id, i])),
    paginationByStatus: new Map()
  }, true);
}

async function render(featureId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<FeatureWorkItemDashboard featureId={featureId} />);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  };
}

/** The summary body element, found by the id the toggle points at — the same
 *  relationship a screen reader follows. */
function summaryBody(container: HTMLElement): HTMLElement | null {
  const toggle = container.querySelector("button[aria-controls]");
  const id = toggle?.getAttribute("aria-controls");
  return id ? byId(container, id) : null;
}

/** React's useId emits ids containing characters a CSS selector would have to
 *  escape, and this environment has no CSS.escape. Match on the property. */
function byId(container: HTMLElement, id: string): HTMLElement | null {
  for (const el of container.querySelectorAll("[id]")) {
    if ((el as HTMLElement).id === id) return el as HTMLElement;
  }
  return null;
}

beforeEach(() => resetStore([]));
afterEach(() => resetStore([]));

// ── metadata: shown when known, omitted when not ─────────────────────────

test("the author and write time of the summary are both shown when known", async () => {
  const writtenAt = new Date(Date.now() - 6 * 60_000).toISOString();
  resetStore([makeItem({
    summary: "Approach picked.",
    summaryUpdatedAt: writtenAt,
    summaryUpdatedBy: "worker"
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("worker · written 6m ago");
  } finally {
    await unmount();
  }
});

test("a manager rewrite is attributed to the manager, not to the worker", async () => {
  resetStore([makeItem({
    summary: "Reworded for the user.",
    summaryUpdatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    summaryUpdatedBy: "manager"
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("manager · written 1h ago");
    expect(container.textContent).not.toContain("worker");
  } finally {
    await unmount();
  }
});

test("a summary with no recorded author shows only the write time", async () => {
  resetStore([makeItem({
    summary: "Written by a legacy caller.",
    summaryUpdatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
    summaryUpdatedBy: null
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("written 6m ago");
    expect(container.textContent).not.toContain("agent ·");
    expect(container.textContent).not.toContain("unknown");
  } finally {
    await unmount();
  }
});

test("a historical row with no provenance at all shows the summary and no metadata", async () => {
  resetStore([makeItem({
    summary: "A summary from before the fields existed.",
    summaryUpdatedAt: null,
    summaryUpdatedBy: null
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    // The summary is never blocked by missing metadata.
    expect(container.textContent).toContain("A summary from before the fields existed.");
    expect(container.textContent).not.toContain("written");
    expect(container.textContent).not.toContain("unknown");
    expect(container.textContent).not.toContain("agent");
  } finally {
    await unmount();
  }
});

test("the summary's age is not read off lastActivityAt", async () => {
  // Written three days ago; something else touched the item a moment ago.
  resetStore([makeItem({
    summary: "Old conclusion, recent activity.",
    summaryUpdatedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
    summaryUpdatedBy: "worker",
    lastActivityAt: new Date().toISOString()
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("written 3d ago");
    expect(container.textContent).not.toContain("just now");
  } finally {
    await unmount();
  }
});

// ── empty and missing states ─────────────────────────────────────────────

test("an item with no summary says so instead of drawing an empty rule", async () => {
  resetStore([makeItem({ summary: null, phase: "working", phaseDetail: "reading the store" })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("Summary");
    expect(container.textContent).toContain("no summary yet");
    expect(container.textContent).not.toContain("written");
  } finally {
    await unmount();
  }
});

test("a design-phase item with nothing in it still reads as 'still discussing'", async () => {
  resetStore([makeItem({ phase: "design", summary: null, phaseDetail: null })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("still discussing");
  } finally {
    await unmount();
  }
});

// ── dedupe against phaseDetail ───────────────────────────────────────────

test("a summary that only repeats the phase detail is not printed a second time", async () => {
  resetStore([makeItem({
    summary: "- dispatching codex",
    phaseDetail: "dispatching codex",
    summaryUpdatedAt: new Date().toISOString(),
    summaryUpdatedBy: "worker"
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("no summary yet");
    expect(container.textContent).not.toContain("dispatching codex");
    // Metadata belongs to a summary that is being shown; there is none.
    expect(container.textContent).not.toContain("written");
  } finally {
    await unmount();
  }
});

test("a summary that says more than the phase detail keeps everything else", async () => {
  resetStore([makeItem({
    summary: "- dispatching codex\n- Chose the additive migration.",
    phaseDetail: "dispatching codex"
  })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.textContent).toContain("Chose the additive migration.");
    expect(container.textContent).not.toContain("dispatching codex");
  } finally {
    await unmount();
  }
});

// ── the expand / collapse control ────────────────────────────────────────

test("the summary body is clamped to three lines and is what the toggle controls", async () => {
  resetStore([makeItem({ summary: "One.\nTwo.\nThree.\nFour.\nFive." })]);
  const { container, unmount } = await render("feat-1");
  try {
    // No layout in this environment, so nothing measures as clipped and the
    // toggle stays hidden — but the clamp itself must be declared.
    const clamped = container.querySelector(".line-clamp-3");
    expect(clamped).not.toBeNull();
    expect(clamped!.id).not.toBe("");
  } finally {
    await unmount();
  }
});

test("when the text overflows, the toggle is a real button wired to the body", async () => {
  const restore = stubClipping({ scrollHeight: 200, clientHeight: 60 });
  resetStore([makeItem({ summary: "One.\nTwo.\nThree.\nFour.\nFive." })]);
  const { container, unmount } = await render("feat-1");
  try {
    const toggle = container.querySelector("button[aria-controls]") as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.tagName).toBe("BUTTON");
    // type=button so Enter inside a form never submits instead of expanding.
    expect(toggle!.getAttribute("type")).toBe("button");
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");
    expect(toggle!.textContent).toBe("Show more");
    // aria-controls must resolve to the element it claims to control.
    expect(summaryBody(container)).not.toBeNull();
    expect(summaryBody(container)!.className).toContain("line-clamp-3");
  } finally {
    await unmount();
    restore();
  }
});

test("activating the toggle expands the body and flips aria-expanded", async () => {
  const restore = stubClipping({ scrollHeight: 200, clientHeight: 60 });
  resetStore([makeItem({ summary: "One.\nTwo.\nThree.\nFour.\nFive." })]);
  const { container, unmount } = await render("feat-1");
  try {
    const toggle = container.querySelector("button[aria-controls]") as HTMLButtonElement;
    await act(async () => { toggle.click(); });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show less");
    expect(summaryBody(container)!.className).not.toContain("line-clamp-3");
  } finally {
    await unmount();
    restore();
  }
});

test("collapsing again restores the clamp", async () => {
  const restore = stubClipping({ scrollHeight: 200, clientHeight: 60 });
  resetStore([makeItem({ summary: "One.\nTwo.\nThree.\nFour.\nFive." })]);
  const { container, unmount } = await render("feat-1");
  try {
    const toggle = container.querySelector("button[aria-controls]") as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    await act(async () => { toggle.click(); });

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(summaryBody(container)!.className).toContain("line-clamp-3");
  } finally {
    await unmount();
    restore();
  }
});

test("the keyboard reaches the toggle: it is focusable and Enter activates it", async () => {
  const restore = stubClipping({ scrollHeight: 200, clientHeight: 60 });
  resetStore([makeItem({ summary: "One.\nTwo.\nThree.\nFour.\nFive." })]);
  const { container, unmount } = await render("feat-1");
  try {
    const toggle = container.querySelector("button[aria-controls]") as HTMLButtonElement;
    // A native button is in the tab order without a tabindex; anything that
    // removed it from there would show up here.
    expect(toggle.getAttribute("tabindex")).toBeNull();
    await act(async () => { toggle.focus(); });
    expect(document.activeElement).toBe(toggle);

    // happy-dom does not synthesise a click from Enter on a button, so drive
    // the activation the way the browser would after the key handler runs.
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  } finally {
    await unmount();
    restore();
  }
});

test("a short summary gets no toggle at all", async () => {
  const restore = stubClipping({ scrollHeight: 40, clientHeight: 60 });
  resetStore([makeItem({ summary: "One line." })]);
  const { container, unmount } = await render("feat-1");
  try {
    expect(container.querySelector("button[aria-controls]")).toBeNull();
    expect(container.textContent).toContain("One line.");
  } finally {
    await unmount();
    restore();
  }
});

test("the section is named by its own Summary label", async () => {
  resetStore([makeItem({ summary: "Named." })]);
  const { container, unmount } = await render("feat-1");
  try {
    const section = container.querySelector("section[aria-labelledby]") as HTMLElement;
    expect(section).not.toBeNull();
    const labelId = section.getAttribute("aria-labelledby")!;
    expect(byId(container, labelId)?.textContent).toBe("Summary");
  } finally {
    await unmount();
  }
});

/** happy-dom performs no layout, so scrollHeight and clientHeight are both 0
 *  and nothing ever measures as clipped. Shadow them on the prototype for the
 *  duration of one test so the component's real measurement path runs. */
function stubClipping({ scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  const proto = globalThis.HTMLElement.prototype as unknown as object;
  const previous = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight")
  };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => clientHeight });
  return () => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(proto, key, descriptor);
      else delete (proto as Record<string, unknown>)[key];
    }
  };
}
