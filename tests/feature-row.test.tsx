import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { FeatureRow } from "../src/client/routes/projects/FeatureRow.js";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";
import { emptyPlan, type PlanStepStatus } from "../src/shared/api/plans";
import { useFeaturePlansStore } from "../src/client/store/feature-plans";
import { useSnapshotStore } from "../src/client/store/snapshot";
import { useWakeActivityStore } from "../src/client/store/wake-activity";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners";
import { SSE_EVENTS } from "../src/shared/api-contracts";
import { fakePhoneWidth } from "./fake-phone-width";
import { onCleanup, runCleanups } from "./helpers/cleanup.js";
import { mount, type Mounted } from "./helpers/mount.js";
import { clientFeature } from "./helpers/client-builders.js";

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

describe("FeatureRow, passive variant", () => {
  afterEach(() => {
    // Unmount before the plans the rows read are reset under them.
    runCleanups();
    useFeaturePlansStore.setState({ plans: new Map() });
  });

  function makeFeature(overrides: Partial<Feature> = {}): Feature {
    return clientFeature("f-1", {
      projectId: "p", name: "feat-foo", tmuxWindowName: "feat-foo-window",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      ownerThreadId: null, tmuxStatus: "alive",
      ...overrides
    });
  }

  function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
    return {
      id: "wi-1", featureId: "f-1", projectId: "p",
      title: "t",
      lastActivityAt: "2026-05-19T00:00:00Z",
      createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
      failedAt: null, failedMessage: null, failedKind: null,
      ...overrides
    };
  }

  test("renders the plan's state line and the feature name", () => {
    useFeaturePlansStore.setState({ plans: new Map([["f-1", {
      ...emptyPlan("f-1"),
      steps: [{ id: 1, title: "writing tests", status: "in_progress", note: null, createdAt: "2026-05-19T12:00:00Z",
        startedAt: "2026-05-19T12:00:00Z", blockedAt: null, completedAt: null, updatedAt: "2026-05-19T12:00:00Z" }],
      updatedAt: "2026-05-19T12:00:00Z"
    }]]) });
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="passive"
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem()}
          paneStatus="running"
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    ).host;
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-slot="feature-state-line"]')!.textContent).toBe("In progress0/1Now:writing tests");
    expect(text).toContain("feat-foo");
  });

  test("pinned feature shows visible star at default opacity", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="passive"
          projectSlug="p"
          feature={makeFeature({ pinnedAt: "2026-05-01T00:00:00Z" })}
          item={makeItem()}
          paneStatus={null}
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    ).host;
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

  // ── row actions per breakpoint ─────────────────────────────────────────────
  // Which controls a row carries is decided by rendering on `useIsMobile()`, not
  // by CSS gates, so a phone test must narrow the window BEFORE mount
  // (fakePhoneWidth) and a desktop test simply mounts at happy-dom's 1024px.
  // happy-dom applies no stylesheet, so the one CSS gate that remains — the
  // hover slot's `md:group-hover:opacity-100` — is asserted through the utility
  // that sets it, always positively (an absent class proves nothing).

  function byLabel(root: HTMLElement, label: string | RegExp): HTMLButtonElement[] {
    return Array.from(root.getElementsByTagName("button")).filter((b) => {
      const value = b.getAttribute("aria-label") ?? "";
      return typeof label === "string" ? value === label : label.test(value);
    });
  }

  const chatControls = (root: HTMLElement) => byLabel(root, "Open worker");

  test("desktop: exactly one Chat and one pin, both in the hover slot", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="passive" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" onPromote={() => {}} onTogglePin={() => {}} />
      </MemoryRouter>
    ).host;
    const row = container.querySelector('[data-slot="feature-row"]')!;
    const chats = row.querySelectorAll('[aria-label="Open worker"]');
    const pins = row.querySelectorAll('[aria-label="Pin to top"]');
    expect(chats.length).toBe(1);
    expect(pins.length).toBe(1);
    expect(gateChain(chats[0]!, row).split(/\s+/)).toContain("md:group-hover:opacity-100");
    expect(row.querySelector('[data-slot="feature-actions-touch"]') === null).toBe(true);
  });

  test("phone: a passive row is one line — no action row, no Chat, no pin, no slug chip", () => {
    onCleanup(fakePhoneWidth(390));
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="passive" projectSlug="p" feature={makeFeature()} item={makeItem({ title: "Auth migration" })} paneStatus="idle" onPromote={() => {}} onTogglePin={() => {}} />
      </MemoryRouter>
    ).host;
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
    document.body.appendChild(outer);
    onCleanup(() => outer.remove());
    outer.addEventListener("click", () => { escaped++; });

    function LocationProbe() {
      const location = useLocation();
      useEffect(() => { path = location.pathname; }, [location.pathname]);
      return null;
    }

    const { host } = mount(
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
      </MemoryRouter>,
      { parent: outer }
    );
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
  });

  test("a card with no onPromote renders no Chat control", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="passive" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" />
      </MemoryRouter>
    ).host;
    expect(container.querySelector('[aria-label="Open worker"]') === null).toBe(true);
  });

  test("passive card never shows a step's note inline (no preview, no expand)", () => {
    useFeaturePlansStore.setState({ plans: new Map([["f-1", { ...emptyPlan("f-1"), steps: [{
      id: 1, title: "wire the plugin", status: "in_progress", note: "important content",
      createdAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.000Z", blockedAt: null, completedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z"
    }], updatedAt: "2026-01-01T00:00:00.000Z" }]]) });
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="passive"
          projectSlug="p"
          feature={makeFeature()}
          item={makeItem({})}
          paneStatus={null}
          onTogglePin={() => {}}
        />
      </MemoryRouter>
    ).host;
    // A note stays out of the compact card — the feature page is the place for it.
    expect(container.textContent).toContain("wire the plugin");
    expect(container.textContent?.includes("important content")).toBe(false);
  });
});

describe("FeatureRow, top variant", () => {
  function makeFeature(overrides: Partial<Feature> = {}): Feature {
    return clientFeature("f-1", {
      projectId: "p", name: "feat-login", tmuxWindowName: "login",
      createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
      ownerThreadId: null, tmuxStatus: "alive",
      ...overrides
    });
  }

  function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
    return {
      id: "wi-1", featureId: "f-1", projectId: "p",
      title: "Auth migration",
      lastActivityAt: "2026-05-19T00:00:00Z",
      createdAt: "2026-05-19T00:00:00Z", updatedAt: "2026-05-19T00:00:00Z",
      failedAt: null, failedMessage: null, failedKind: null,
      ...overrides
    };
  }

  let view: Mounted;
  let container: HTMLElement;
  function render(node: ReactNode) {
    view = mount(node);
    container = view.host;
  }

  function noop() {}

  type SeedStep = { status: PlanStepStatus; title?: string; note?: string };

  /** A plan whose worker asks a question. */
  function seedAskingPlan(...steps: SeedStep[]) {
    seedPlanWith(["Split the cache into its own PR?"], steps);
  }

  function seedPlan(...steps: SeedStep[]) {
    seedPlanWith([], steps);
  }

  function seedPlanWith(openQuestions: string[], steps: SeedStep[]) {
    useFeaturePlansStore.setState({ plans: new Map([["f-1", {
      ...emptyPlan("f-1"),
      conclusion: "Waiting on upstream",
      openQuestions,
      steps: steps.map((st, i) => ({
        id: i + 1, title: st.title ?? `step ${i + 1}`, status: st.status, note: st.note ?? "n",
        createdAt: "2026-09-14T12:00:00.000Z", startedAt: null, blockedAt: null, completedAt: null, updatedAt: "2026-09-14T12:00:00.000Z"
      })),
      updatedAt: "2026-09-14T12:00:00.000Z"
    }]]) });
  }

  function renderRow(item: WorkItemDto, paneStatus: "running" | "idle" = "idle") {
    render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={item} paneStatus={paneStatus}
          onTogglePin={noop} onAck={noop} onPromote={noop} />
      </MemoryRouter>
    );
    const q = (slot: string) => container.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;
    return { state: q("feature-state"), progress: q("feature-progress"), line: q("feature-state-line") };
  }

  afterEach(() => {
    // Unmount before the plans and snapshot the row reads are reset under it.
    runCleanups();
    useFeaturePlansStore.setState({ plans: new Map() });
    useWakeActivityStore.setState({ activeByFeatureId: new Map() });
    useSnapshotStore.setState({ snapshot: null });
  });

  test("line two reads the plan: one case per state", () => {
    // The state and the progress each in its own slot, then the whole line.
    const cases: Array<[Array<{ status: PlanStepStatus; title?: string }>, ReturnType<typeof renderRow>]> = [
      [[{ status: "done" }, { status: "in_progress", title: "wire the reset" }], { state: "In progress", progress: "1/2", line: "In progress1/2Now:wire the reset" }],
      [[{ status: "done" }, { status: "blocked", title: "wait for project-2" }], { state: "Blocked", progress: "1/2", line: "Blocked1/2wait for project-2" }],
      [[{ status: "done" }, { status: "pending", title: "cover the plugin" }], { state: "Paused", progress: "1/2", line: "Paused1/2Next:cover the plugin" }],
      [[{ status: "done" }], { state: "Done", progress: "1/1", line: "Done1/1Waiting on upstream" }],
      [[], { state: "Planning", progress: null, line: "PlanningWaiting on upstream" }]
    ];
    for (const [steps, expected] of cases) {
      seedPlan(...steps);
      expect(renderRow(makeItem({}))).toEqual(expected);
      view.unmount();
    }
  });

  // The state word leads line two; a lead that only says it again goes
  // ("Failed 6/7 Failed: Model provider authentication failed.").
  test("line two never says its state word twice", () => {
    seedPlan({ status: "done" }, { status: "in_progress", title: "wire the reset" });
    const failure = { failedAt: "2026-10-09T03:59:00.000Z", failedMessage: "Model provider authentication failed." };
    expect(renderRow(makeItem({ ...failure, failedKind: "error" }))).toEqual({
      state: "Failed", progress: "1/2", line: "Failed1/2Model provider authentication failed."
    });
    view.unmount();
    expect(renderRow(makeItem({ ...failure, failedKind: "stopped" }))).toEqual({
      state: "Stopped", progress: "1/2", line: "Stopped1/2Model provider authentication failed."
    });
  });

  // The time sits on the title line in every row: a row without a
  // slug centred its lone time between the two lines, out of line with the
  // rows around it.
  test("a row without a slug keeps its time on the title line", () => {
    renderTopWithSlug("feat-login");
    const right = container.querySelector('[data-slot="feature-right"]')!;
    expect(container.querySelector('[data-slot="feature-slug"]') === null).toBe(true);
    expect(right.children.length).toBe(2);
    expect(right.lastElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(right.lastElementChild!.className.split(/\s+/)).toContain("text-2xs");
    // An empty span makes no line box; a no-break space makes one the slug's height.
    expect(right.lastElementChild!.textContent).toBe("\u00a0");
    // And the time's line is the title's height, so the column is no taller
    // than the two lines beside it (a 22px line made every row with
    // a slug, or its placeholder, 4px taller than one without).
    expect(right.querySelector('[data-slot="feature-time-line"]')!.className.split(/\s+/))
      .toContain("h-[calc(var(--text-xs)*var(--text-xs--line-height))]");
  });

  // What a worker asks is its plan's question: no flag says so. At rest it
  // waits for the answer, and the row offers the reply box and an Ack for a
  // question that needs no answer any more.
  test("a row whose worker waits for an answer shows the question once, in the reply box, and the conclusion on line two", () => {
    seedAskingPlan({ status: "in_progress" });
    const row = renderRow(makeItem({}));
    expect(row.state).toBe("Waiting for an answer");
    expect(row.line).toBe("Waiting for an answer0/1Waiting on upstream");
    expect(container.textContent).toContain("Reply");
    expect(container.textContent!.split("Split the cache into its own PR?").length - 1).toBe(1);
    expect(Array.from(container.getElementsByTagName("button")).some((b) => (b.textContent ?? "").toLowerCase().includes("ack"))).toBe(true);
  });

  // Ack dismisses a question; with none, there is nothing to acknowledge: a
  // failure is its manager's to handle, and a finished plan needs no flag.
  test("Ack shows only for a question: not for a failed worker, nor a finished one", () => {
    const hasAck = () => Array.from(container.getElementsByTagName("button")).some((b) => b.textContent?.trim() === "Ack");
    seedPlan({ status: "in_progress" });
    renderRow(makeItem({ failedAt: "2026-10-09T03:59:00.000Z", failedMessage: "boom", failedKind: "error" }));
    expect(hasAck()).toBe(false);
    view.unmount();
    seedPlan({ status: "done" });
    renderRow(makeItem());
    expect(hasAck()).toBe(false);
    view.unmount();
    seedAskingPlan({ status: "in_progress" });
    renderRow(makeItem());
    expect(hasAck()).toBe(true);
  });

  test("a worker still in its turn is at work: its question is not put in a box yet", () => {
    seedAskingPlan({ status: "in_progress", title: "wire the reset" });
    useWakeActivityStore.setState({ activeByFeatureId: new Map([["f-1", { wakeId: "wake-1", startedAt: "2026-10-14T10:00:00.000Z" }]]) });
    const row = renderRow(makeItem({}));
    expect(row.line).toBe("In progress0/1Now:wire the reset");
    expect(container.textContent).not.toContain("Reply");
  });

  test("an in-progress step names its pane as the snapshot knows it", () => {
    seedPlan({ status: "in_progress", title: "review", note: "Codex review running in %133" });
    useSnapshotStore.setState({ snapshot: { sessions: [{ windows: [{ panes: [{ paneId: "%133", metadata: { name: "Codex review", description: "", updatedAt: "" } }] }] }] } });
    expect(renderRow(makeItem({})).line).toBe("In progress0/1Now:review· Codex review");
  });

  test("line two is 12px and keeps the row at 52px; motion only while work runs", () => {
    seedPlan({ status: "in_progress" });
    renderRow(makeItem({}), "running");
    const row = container.querySelector('[data-slot="feature-row"]')!;
    const state = container.querySelector('[data-slot="feature-state"]')!;
    const chain = gateChain(state, row).split(/\s+/);
    expect(chain).toContain("text-2xs");
    expect(chain).not.toContain("text-xs");
    const rowTokens = row.className.split(/\s+/);
    for (const t of ["min-h-13", "py-1.5", "justify-center"]) expect(rowTokens).toContain(t);
    expect(rowTokens).not.toContain("py-2");
    expect(container.querySelectorAll(".animate-live").length).toBe(1);
    expect(state.className.split(/\s+/)).not.toContain("animate-live");
  });

  test("a worker's wake over SSE starts the row's motion, and its finish stops it", () => {
    seedPlan({ status: "in_progress" });
    useWakeActivityStore.setState({ activeByFeatureId: new Map() });
    onCleanup(() => useWakeActivityStore.setState({ activeByFeatureId: new Map() }));
    const source = new EventTarget() as EventSource;
    attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: noop, onReconnect: noop });
    const send = (type: string, data: unknown) => act(() => {
      source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    });
    renderRow(makeItem({}));
    const live = () => container.querySelectorAll(".animate-live").length;
    expect(live()).toBe(0);
    const wake = { threadId: "t-1", wakeId: "w-1", scope: "worker", scopeId: "f-1" };
    send(SSE_EVENTS.agentWakeStarted, { ...wake, reason: "user", startedAt: "2026-09-14T12:00:00.000Z" });
    expect(live()).toBe(1);
    send(SSE_EVENTS.agentWakeFinished, { ...wake, status: "finished" });
    expect(live()).toBe(0);
  });

  test("clicking ☆ calls onTogglePin", () => {
    let pinCalls = 0;
    render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={() => { pinCalls++; }} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
    const btns = Array.from(container.getElementsByTagName("button"));
    const pinBtn = btns.find((b) => {
      const a = b.getAttribute("aria-label");
      return a === "Pin to top" || a === "Unpin";
    });
    expect(pinBtn).toBeDefined();
    act(() => { pinBtn!.click(); });
    expect(pinCalls).toBe(1);
  });

  test("clicking ack quick action calls onAck", () => {
    let n = 0;
    seedAskingPlan({ status: "in_progress" });
    render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus={null}
          onTogglePin={noop} onAck={() => { n++; }} onPromote={noop}
        />
      </MemoryRouter>
    );
    const btns = Array.from(container.getElementsByTagName("button"));
    const ackBtn = btns.find((b) => (b.textContent ?? "").toLowerCase().includes("ack"));
    expect(ackBtn).toBeDefined();
    act(() => { ackBtn!.click(); });
    expect(n).toBe(1);
  });

  test("desktop: one Ack in the hover slot, slug chip on line one, no touch row", () => {
    const onAck = () => {};
    seedAskingPlan({ status: "in_progress" });
    render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" onAck={onAck} />
      </MemoryRouter>
    );
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
  });

  test("phone: a needs-you row gets one 44px action row after line one; no slug chip anywhere", () => {
    onCleanup(fakePhoneWidth(390));
    let acked = 0;
    seedAskingPlan({ status: "in_progress" });
    render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={makeItem()}
          paneStatus="idle" onAck={() => { acked += 1; }} onPromote={() => {}} onTogglePin={() => {}} />
      </MemoryRouter>
    );
    const row = container.querySelector<HTMLElement>('[data-slot="feature-row"]')!;
    const touchRow = row.querySelector<HTMLElement>('[data-slot="feature-actions-touch"]')!;
    expect(touchRow === null).toBe(false);
    expect(touchRow.parentElement === row).toBe(true);
    // happy-dom's closest() has no `:scope`; walk up to the row's direct child.
    let lineOne: Element = row.querySelector('[data-slot="feature-title"]')!;
    while (lineOne.parentElement !== row) lineOne = lineOne.parentElement!;
    expect(touchRow.compareDocumentPosition(lineOne) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const buttons = Array.from(touchRow.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).toEqual(["Ack", "Open worker", "Pin to top"]);
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
  });

  test("phone: Ack renders no pointer twin — the hover slot is empty of Ack", () => {
    onCleanup(fakePhoneWidth(390));
    seedAskingPlan({ status: "in_progress" });
    render(
      <MemoryRouter>
        <FeatureRow variant="top" projectSlug="p" feature={makeFeature()} item={makeItem()} paneStatus="idle" onAck={() => {}} />
      </MemoryRouter>
    );
    const row = container.querySelector('[data-slot="feature-row"]')!;
    const acks = Array.from(row.querySelectorAll("button")).filter((b) => b.textContent?.trim() === "Ack");
    expect(acks.length).toBe(1);
    expect(gateChain(acks[0]!, row).split(/\s+/)).not.toContain("md:group-hover:opacity-100");
  });

  // The slug chip is desktop-only: measured at 390×844 it left the title 34px
  // wide beside the pill and the time, and a second line for it was the old
  // always-present touch row. Below md the row renders no chip at all.
  function renderTopWithSlug(title: string | null = "Auth migration") {
    render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature({ name: "feat-login", tmuxWindowName: "login" })}
          item={makeItem({ title: title ?? "" })}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
  }

  test("the slug is faint mono text in the right column under the time — off the title line and off the state line", () => {
    renderTopWithSlug("Issue #39 · waiting on review");
    const slug = container.querySelector('[data-slot="feature-slug"]')!;
    expect(slug === null).toBe(false);
    const tokens = slug.className.split(/\s+/);
    for (const t of ["font-mono", "text-faint", "truncate", "max-w-[18rem]"]) expect(tokens).toContain(t);
    for (const t of ["border", "rounded-full", "bg-sel", "pill", "min-w-0", "shrink"]) expect(tokens).not.toContain(t);
    expect(slug.textContent).toContain("login");
    // Its home is the right column (`[data-slot="feature-right"]`): a column that
    // stacks the time line above it and never shrinks, so the slug has its own
    // width and the state line keeps the whole second line. It is the column's
    // last child so it sits under the time, right-aligned.
    const right = container.querySelector('[data-slot="feature-right"]')!;
    expect(right === null).toBe(false);
    for (const t of ["flex", "flex-col", "items-end", "shrink-0"]) expect(right.className.split(/\s+/)).toContain(t);
    expect(right.contains(slug)).toBe(true);
    expect(right.lastElementChild === slug).toBe(true);
    const stateLine = container.querySelector('[data-slot="feature-state-line"]')!;
    expect(stateLine.contains(slug)).toBe(false);
    expect(container.querySelector('[data-slot="feature-title"]')!.contains(slug)).toBe(false);
  });

  test("does not render ack action when work item no longer needs user", () => {
    render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature()}
          item={makeItem({})}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
    const btns = Array.from(container.getElementsByTagName("button"));
    const ackBtn = btns.find((b) => (b.textContent ?? "").toLowerCase().includes("ack"));
    expect(ackBtn === undefined).toBe(true);
  });

  test("card link points to the feature page when the item has a canvas", () => {
    render(
      <MemoryRouter>
        <FeatureRow variant="top"
          projectSlug="p" feature={makeFeature({ tmuxWindowName: "win" })}
          item={makeItem({})}
          paneStatus={null}
          onTogglePin={noop} onAck={noop} onPromote={noop}
        />
      </MemoryRouter>
    );
    const anchors = Array.from(container.getElementsByTagName("a"));
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("href")).toBe("/projects/p/features/win");
  });
});

describe("FeatureRow, untracked variant", () => {
  function makeFeature(overrides: Partial<Feature> = {}): Feature {
    return clientFeature("f-1", {
      projectId: "p", name: "orphan-feature", tmuxWindowName: "orphan-window",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      ownerThreadId: null, tmuxStatus: "alive",
      ...overrides
    });
  }

  test("renders feature.name and 'untracked' label", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="untracked" projectSlug="p" feature={makeFeature()} item={null} paneStatus={null} />
      </MemoryRouter>
    ).host;
    expect(container.textContent).toContain("orphan-feature");
    expect(container.textContent?.toLowerCase()).toContain("untracked");
  });

  test("renders pane status dot when paneStatus provided", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="untracked" projectSlug="p" feature={makeFeature()} item={null} paneStatus="running" />
      </MemoryRouter>
    ).host;
    // assert some indicator of running via aria-label attribute
    const spans = container.getElementsByTagName("span");
    const dot = Array.from(spans).find((el) => el.getAttribute("aria-label") === "pane running");
    expect(dot).not.toBeUndefined();
  });

  // Deliberate boundary: the actions of tracked rows do NOT extend here. An
  // untracked feature is by definition one with no work item
  // (feature-card-data.ts), so there is nothing for them to act on.
  test("untracked rows have no controls at either breakpoint: no Open worker, no pin", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="untracked" projectSlug="p" feature={makeFeature()} item={null} paneStatus={null} />
      </MemoryRouter>
    ).host;
    expect(Array.from(container.getElementsByTagName("button")).map((b) => b.getAttribute("aria-label"))).toEqual([]);
  });

  test("renders link to /projects/:slug/features/:windowName", () => {
    const container = mount(
      <MemoryRouter>
        <FeatureRow variant="untracked" projectSlug="p" feature={makeFeature()} item={null} paneStatus={null} />
      </MemoryRouter>
    ).host;
    const links = container.getElementsByTagName("a");
    expect(links.length).toBeGreaterThan(0);
    const link = links[0];
    expect(link.getAttribute("href")).toContain("/projects/p/features/orphan-window");
  });
});
