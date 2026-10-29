import { afterEach, expect, test } from "bun:test";
import { act, useLayoutEffect, useRef, type ReactNode } from "react";
import { mount } from "../helpers/mount.js";
import { runCleanups } from "../helpers/cleanup.js";
import { stubSentTextHeights } from "../helpers/sent-text-layout.js";
import { clientFeature, clientProject } from "../helpers/client-builders.js";
import { HandoffCard } from "@/routes/global/HandoffCard";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useProjectsStore } from "@/store/projects";
import type { GlobalHandoffDto } from "@shared/api/global-agent";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import { foldOpenKey } from "@/routes/window/chat/transcript-rows";
import type { AgentMessage } from "@/store/agent-chat";

afterEach(() => {
  runCleanups();
  useGlobalAgentStore.setState({ agent: null, handoffs: new Map() });
  act(() => useProjectsStore.getState().setProjectsState([]));
});

const feature = clientFeature("feat_1", {
  name: "release", tmuxWindowName: "release-win", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", ownerThreadId: "thr_m"
});
const project = clientProject("p1", {
  name: "mandate", workingDir: "/m", tmuxSessionName: "md-project-1", createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", features: [feature]
});

const handoff = (over: Partial<GlobalHandoffDto>): GlobalHandoffDto => ({
  id: "hof_1", kind: "feature", state: "delivered", text: "Keep the old install script", spoken: false,
  featureId: "feat_1", featureName: "release", ownerThreadTitle: "Docs overhaul",
  threadId: "thr_w", threadTitle: null, newThreadTitle: null, reply: null, reason: null, stop: null,
  createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", repliedAt: null, ...over
});

const card = (host: HTMLElement) => host.querySelector('[data-slot="handoff-card"]')!;

const toThread = { kind: "thread" as const, featureId: null, featureName: null, ownerThreadTitle: null, threadId: "thr_t", threadTitle: "PR reviews" };

test("a card reads 'Sent to <target>' for a thread and for a worker, the worker with its thread; what comes back is not drawn on it", () => {
  const { host, rerender } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({})} />, { path: "/agent" });
  expect(card(host).textContent).toContain("Sent to release · in Docs overhaul");
  act(() => { useGlobalAgentStore.getState().upsertHandoff(handoff({ state: "replied", stop: "stopped", reply: "OK, it stays.", repliedAt: "2026-10-05T10:05:00.000Z" })); });
  rerender(<HandoffCard handoffId="hof_1" fallback={handoff({})} />);
  // The notice that woke the agent says what came back, where it arrived.
  expect(card(host).querySelector('[data-slot="handoff-reply"]') === null).toBe(true);
  expect(card(host).textContent).not.toContain("OK, it stays.");
  const thread = mount(<HandoffCard handoffId="hof_2" fallback={handoff({ id: "hof_2", ...toThread, state: "delivered" })} />, { path: "/agent" });
  expect(card(thread.host).textContent).toContain("Sent to PR reviews");
  expect(card(thread.host).textContent).not.toContain("Handed to");
});

test("a pill only for what is unusual: a new thread, queued, failed, an old canceled; none when it simply went or came back", () => {
  const pill = (over: Partial<GlobalHandoffDto>) => {
    const { host, unmount } = mount(<HandoffCard handoffId="hof_1" fallback={handoff(over)} />, { path: "/agent" });
    const seen = card(host).querySelector('[data-slot="handoff-state"]')?.textContent ?? null;
    unmount();
    return seen;
  };
  expect(pill({ state: "delivered" })).toBeNull();
  expect(pill({ state: "replied", stop: "stopped", repliedAt: "2026-10-05T10:05:00.000Z" })).toBeNull();
  expect(pill({ ...toThread, state: "delivered", newThreadTitle: "PR reviews" })).toBe("New thread");
  expect(pill({ ...toThread, state: "replied", stop: "stopped", newThreadTitle: "PR reviews", repliedAt: "2026-10-05T10:05:00.000Z" })).toBe("New thread");
  expect(pill({ state: "queued" })).toBe("Queued · worker busy");
  expect(pill({ ...toThread, state: "queued" })).toBe("Queued · manager busy");
  expect(pill({ ...toThread, state: "failed", stop: "failed", newThreadTitle: "PR reviews" })).toBe("Failed");
});

test("a failure with no moment anything came back says why on the card", () => {
  // Its target was archived: nothing came back, so no line will say it.
  const { host } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ state: "failed", stop: "archived", reason: "the worker was archived" })} />, { path: "/agent" });
  expect(card(host).querySelector('[data-slot="handoff-state"]')!.textContent).toBe("Failed");
  expect(card(host).querySelector('[data-slot="handoff-reason"]')!.textContent).toBe("the worker was archived");
});

test("what was sent is under the line as plain text, two lines until opened", () => {
  const long = "Fix the search page so that a slow query no longer ends in a **timeout**.\n\nDone means: the page shows a retry hint; one test is added; the e2e suite has run.";
  const tall = stubSentTextHeights({ full: 80, clamped: 40 });
  try {
    const { host } = mount(<HandoffCard handoffId="hof_long" fallback={handoff({ ...toThread, id: "hof_long", state: "delivered", text: long })} />, { path: "/agent" });
    const sent = card(host).querySelector('[data-slot="handoff-sent"]')!;
    expect(sent.textContent).toContain("Fix the search page so that a slow query no longer ends in a timeout.");
    expect(sent.textContent).not.toContain("**");
    expect(sent.getAttribute("data-folded")).toBe("true");
    expect(sent.className.split(/\s+/)).toContain("line-clamp-2");
    const fold = () => card(host).querySelector<HTMLButtonElement>('[data-slot="sent-fold"]')!;
    expect([fold().textContent, fold().getAttribute("aria-expanded")]).toEqual(["Show more", "false"]);
    act(() => { fold().click(); });
    expect(sent.getAttribute("data-folded")).toBe("false");
    expect(sent.className.split(/\s+/)).not.toContain("line-clamp-2");
    // Opened, it is no taller than its box any more: the control must stay.
    expect([fold().textContent, fold().getAttribute("aria-expanded")]).toEqual(["Show less", "true"]);
    act(() => { fold().click(); });
    expect(sent.getAttribute("data-folded")).toBe("true");
  } finally {
    tall.restore();
  }
});

// In a transcript the fold is one of the things the reader opened there: the
// list holds it, so it can stop following while it is open.
test("given the transcript's opened set, the card's fold is read from it, and a click reports the card's key", () => {
  const long = "Fix the search page so that a slow query no longer ends in a timeout.\n\nDone means: the page shows a retry hint; one test is added; the e2e suite has run.";
  const tall = stubSentTextHeights({ full: 80, clamped: 40 });
  try {
    const changes: Array<[string, boolean]> = [];
    const draw = (opened: Set<string>) => (
      <HandoffCard handoffId="hof_listed" fallback={handoff({ ...toThread, id: "hof_listed", state: "delivered", text: long })}
        expandedIds={opened} onExpandedChange={(id, open) => changes.push([id, open])} />
    );
    const { host, rerender } = mount(draw(new Set()), { path: "/agent" });
    const sent = () => card(host).querySelector('[data-slot="handoff-sent"]')!;
    const fold = () => card(host).querySelector<HTMLButtonElement>('[data-slot="sent-fold"]')!;
    act(() => { fold().click(); });
    expect(changes).toStrictEqual([[foldOpenKey("hof_listed"), true]]);
    // The set is the list's to change: until it does, nothing opened.
    expect([sent().getAttribute("data-folded"), fold().textContent]).toEqual(["true", "Show more"]);
    rerender(draw(new Set([foldOpenKey("hof_listed")])));
    expect([sent().getAttribute("data-folded"), fold().textContent]).toEqual(["false", "Show less"]);
    act(() => { fold().click(); });
    expect(changes).toStrictEqual([[foldOpenKey("hof_listed"), true], [foldOpenKey("hof_listed"), false]]);
  } finally {
    tall.restore();
  }
});

// A turn's card is drawn three times as the turn goes on: on its call's row,
// under the words being written, under them once stored. The measurement that
// gives a long text its control runs after the card is in the page. Drawn
// again without the control and given it back, the card grew inside the
// commit that had just made the transcript shorter, and that growth was read
// as the reader scrolling up: the list stopped following on every turn that
// sent a long message and then said so (in a browser).
test("drawn again, a card is committed with the control it was last measured to need", () => {
  const tall = stubSentTextHeights({ full: 80, clamped: 40 });
  try {
    const long = "Fix the search page so that a slow query no longer ends in a timeout.\n\nDone means: the page shows a retry hint; one test is added; the e2e suite has run.";
    // What the page held when the card was first in it, before any measurement
    // could change it: a parent's layout effect runs after its child's and
    // before the render a child's measurement asks for.
    const committed: Array<string | null> = [];
    function AsCommitted({ children }: { children: ReactNode }) {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => { committed.push(ref.current!.querySelector('[data-slot="sent-fold"]')?.textContent ?? null); }, []);
      return <div ref={ref}>{children}</div>;
    }
    const draw = () => mount(
      <AsCommitted><HandoffCard handoffId="hof_redrawn" fallback={handoff({ ...toThread, id: "hof_redrawn", state: "delivered", text: long })} /></AsCommitted>,
      { path: "/agent" }
    );
    const first = draw();
    expect(card(first.host).querySelector('[data-slot="sent-fold"]')?.textContent ?? null).toBe("Show more");
    first.unmount();
    const again = draw();
    expect(card(again.host).querySelector('[data-slot="sent-fold"]')?.textContent ?? null).toBe("Show more");
    // The first time nothing was known; the second, it was.
    expect(committed).toStrictEqual([null, "Show more"]);
  } finally {
    tall.restore();
  }
});

test("a text that fits in two lines has no control; a wait with nothing sent draws no text", () => {
  const fits = stubSentTextHeights({ full: 40, clamped: 40 });
  try {
    const { host, unmount } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "delivered", text: "Run the e2e suite." })} />, { path: "/agent" });
    expect(card(host).querySelector('[data-slot="handoff-sent"]')!.textContent).toBe("Run the e2e suite.");
    expect(card(host).querySelector('[data-slot="sent-fold"]') === null).toBe(true);
    unmount();
    const nothing = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "waiting", text: "" })} />, { path: "/agent" });
    expect(card(nothing.host).querySelector('[data-slot="handoff-sent"]') === null).toBe(true);
  } finally {
    fits.restore();
  }
});

test("a failure that came back at a moment is told where it arrived: the card keeps only its pill", () => {
  const back = handoff({ state: "failed", reason: "It was stopped after it answered.", reply: "Unit tests passed.", repliedAt: "2026-10-05T10:05:00.000Z" });
  const { host } = mount(<HandoffCard handoffId="hof_1" fallback={back} />, { path: "/agent" });
  expect(card(host).querySelector('[data-slot="handoff-state"]')!.textContent).toBe("Failed");
  expect(card(host).querySelector('[data-slot="handoff-reason"]') === null).toBe(true);
  expect(card(host).querySelector('[data-slot="handoff-reply"]') === null).toBe(true);
});

// Nothing on the card led to the thread that did the work.
test("a card opens where it went: the thread, or the worker's chat; a proposal not agreed to opens nothing", () => {
  const open = (over: Partial<GlobalHandoffDto>) => {
    const { host, unmount } = mount(<HandoffCard handoffId="hof_1" fallback={handoff(over)} />, { path: "/agent" });
    const link = card(host).querySelector<HTMLAnchorElement>('a[data-slot="handoff-open"]');
    const seen = link ? [link.textContent, link.getAttribute("href")] : null;
    unmount();
    return seen;
  };
  expect(open({ ...toThread, state: "delivered" })).toEqual(["Open thread", "/threads/thr_t"]);
  // On a phone the words step aside for the thread's name; a screen reader still has them.
  {
    const { host, unmount } = mount(<HandoffCard handoffId="hof_1" fallback={handoff({ ...toThread, state: "delivered" })} />, { path: "/agent" });
    expect(card(host).querySelector('[data-slot="handoff-open"] span')!.className.split(/\s+/)).toContain("@max-[34rem]:sr-only");
    unmount();
  }
  expect(open({ ...toThread, state: "replied", reply: "ok", repliedAt: "2026-10-05T10:05:00.000Z" })).toEqual(["Open thread", "/threads/thr_t"]);
  expect(open({ ...toThread, state: "queued" })).toEqual(["Open thread", "/threads/thr_t"]);
  // A worker not among the projects (none are loaded here) has no page to open.
  expect(open({ state: "delivered" })).toBeNull();
  act(() => useProjectsStore.getState().setProjectsState([project]));
  expect(open({ state: "delivered" })).toEqual(["Open worker", "/projects/md-project-1/features/release-win?tab=chat"]);
});

test("a send_to_thread call reads as its card; a wait with nothing sent is a line of the run and draws no card", () => {
  const sent = handoff({ kind: "thread", state: "delivered", featureName: null, featureId: null, threadId: "thr_t", threadTitle: "PR reviews" });
  const message = {
    id: "m1", threadId: "thr_g", seq: 3, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
    wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [
      { toolCallId: "c1", toolName: "send_to_thread", args: { threadId: "thr_t", text: "x" } },
      { toolCallId: "c2", toolName: "await_stop", args: { threadId: "thr_u" } }
    ] }
  } as unknown as AgentMessage;
  const results = new Map([
    ["c1", { result: { handoff: sent }, createdAt: "2026-10-05T10:00:01.000Z" }],
    ["c2", { result: { waiting: true, handoff: handoff({ id: "hof_w", kind: "thread", state: "waiting", text: "", featureName: null, featureId: null, threadId: "thr_u", threadTitle: "Docs" }) }, createdAt: "2026-10-05T10:00:02.000Z" }]
  ]);
  const { host } = mount(<AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} />, { path: "/agent" });
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
  expect(host.querySelector('[data-slot="handoff-card"]')!.textContent).toContain("PR reviews");
  expect(host.querySelectorAll('[data-slot="tool-run-line"]').length).toBe(1);
  expect(host.querySelector('[data-slot="tool-run-line"]')!.textContent).toContain("Waiting for it to stop");
});

test("a message_feature call reads as its card, not as a tool line; a refused one stays a line", () => {
  const sent = handoff({});
  const message = {
    id: "m1", threadId: "thr_g", seq: 3, role: "assistant", source: "self", sourceThreadId: null, wakeId: "w1",
    wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt: "2026-10-05T10:00:00.000Z",
    content: { type: "assistant", text: "", toolCalls: [
      { toolCallId: "c1", toolName: "message_feature", args: { featureId: "feat_1", text: "x" } },
      { toolCallId: "c2", toolName: "message_feature", args: { featureId: "feat_9", text: "y" } }
    ] }
  } as unknown as AgentMessage;
  const results = new Map([
    ["c1", { result: { handoff: sent }, createdAt: "2026-10-05T10:00:01.000Z" }],
    ["c2", { result: { error: "worker is archived: old" }, createdAt: "2026-10-05T10:00:02.000Z" }]
  ]);
  const { host } = mount(<AssistantMessage message={message} toolResultsByCallId={results} activeToolCallId={null} />, { path: "/agent" });
  expect(host.querySelectorAll('[data-slot="handoff-card"]').length).toBe(1);
  expect(host.querySelectorAll('[data-slot="tool-run-line"]').length).toBe(1);
  // Opened, the run is the refused call alone (one call opens straight to its
  // details, two would list them): the sent one is its card.
  act(() => { host.querySelector<HTMLButtonElement>('[data-slot="tool-run-line"]')!.click(); });
  expect(host.querySelectorAll('[data-slot="tool-details"]').length).toBe(1);
  expect(host.querySelectorAll('[data-slot="tool-call"]').length).toBe(0);
});

